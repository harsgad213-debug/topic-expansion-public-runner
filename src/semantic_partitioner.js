import { extractParts } from "./extract_parts.js";

// ─── Configuration ────────────────────────────────────────────────
const MAX_ATTEMPTS = 3;
const MAX_INPUT_CHARS = 30000;
const WINDOW_CHARS = 24000;
const OVERLAP_CHARS = 4000;

// How many real (non-whitespace/punctuation) chars in a gap before we give up.
const GAP_ABSORB_THRESHOLD = 500;

const GENERIC_MARKERS = [
  "purpose", "summary", "introduction", "example", "overview",
  "definition", "conclusion", "part", "unit", "chapter",
  "section", "title", "heading", "content", "outline", "recap"
];

function isGenericMarker(marker) {
  const lower = marker.trim().toLowerCase();
  return GENERIC_MARKERS.some((word) => {
    if (!lower.startsWith(word)) return false;
    const after = lower.slice(word.length).trimStart();
    if (!after) return true;
    const wordChars = after.replace(/[\d\s\-—:\.\/\\#*]+/g, "");
    return wordChars.length < 5;
  });
}

// ─── JSON helpers ─────────────────────────────────────────────────────────────

function stripMarkdownFences(text) {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function findJsonArray(text) {
  const cleaned = stripMarkdownFences(text);
  // First try to find an array that actually contains objects
  let start = cleaned.search(/\[\s*\{/);
  if (start === -1) {
    // Fallback to finding any array bracket
    start = cleaned.indexOf("[");
  }

  if (start === -1) {
    throw new Error("Model response did not contain a JSON array.");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < cleaned.length; i++) {
    const char = cleaned[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "[") depth++;
    if (char === "]") {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }

  throw new Error("Model response contained an incomplete JSON array.");
}

// Validates and normalises an array of raw partition objects from the model.
// Extracted so both the bare-array and wrapped-object paths can share it.
function validatePartitionItems(parsed) {
  if (!Array.isArray(parsed)) {
    throw new Error("Model JSON response must be an array.");
  }

  return parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Invalid partition at index ${index}: expected object.`);
    }
    const title =
      typeof item.title === "string" && item.title.trim()
        ? item.title.trim()
        : `Section ${index + 1}`;

    if (typeof item.start_marker !== "string") {
      throw new Error(
        `Invalid partition at index ${index}: missing start_marker.`,
      );
    }
    if (typeof item.end_marker !== "string") {
      throw new Error(
        `Invalid partition at index ${index}: missing end_marker.`,
      );
    }
    if (typeof item.approx_position !== "number") {
      throw new Error(
        `Invalid partition at index ${index}: missing approx_position.`,
      );
    }

    return {
      title,
      start_marker: item.start_marker,
      end_marker: item.end_marker,
      approx_position: item.approx_position,
    };
  });
}

function parsePartitionJson(rawText) {
  const cleaned = stripMarkdownFences(rawText);

  // FIX: Some models return {"sections":[...]} or {"partitions":[...]} instead
  // of a bare array. Try the bare-array path first; on failure, unwrap any
  // top-level object and use the first array value found inside it.
  let jsonText;
  let parseError;

  try {
    jsonText = findJsonArray(cleaned);
  } catch (err) {
    parseError = err;
  }

  if (jsonText) {
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (error) {
      throw new Error(`Invalid JSON returned by model: ${error.message}`);
    }
    return validatePartitionItems(parsed);
  }

  // Bare-array extraction failed — try unwrapping an object wrapper.
  const objStart = cleaned.indexOf("{");
  if (objStart !== -1) {
    let wrapper;
    try {
      wrapper = JSON.parse(cleaned.slice(objStart));
    } catch (_) {
      // Wrapper parse also failed; fall through to original error.
    }
    if (wrapper && typeof wrapper === "object" && !Array.isArray(wrapper)) {
      const arrayVal = Object.values(wrapper).find(Array.isArray);
      if (arrayVal) {
        return validatePartitionItems(arrayVal);
      }
    }
  }

  // Nothing worked — re-throw the original findJsonArray error.
  throw (
    parseError ||
    new Error("Model response did not contain a usable JSON array.")
  );
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildPrompt(text, attempt = 1, lastError = null) {
  let reminder = "";
  if (attempt > 1) {
    let errorNudge = "";
    if (lastError && lastError.message) {
      errorNudge = `\n- The previous attempt FAILED validation: "${lastError.message}"`;
      // Extract the specific banned marker from the error to explicitly ban it
      const markerMatch = lastError.message.match(/(?:start_marker|end_marker)\s+"([^"]+)"/);
      if (markerMatch) {
        errorNudge += `\n- BANNED MARKER: Do NOT use "${markerMatch[1]}" as any marker. Pick a completely different, longer, more unique string from the text.`;
      }
      if (lastError.message.includes("too generic")) {
        errorNudge += `\n- GENERIC MARKERS ARE BANNED: Never use single words like "Conclusion", "Summary", "Introduction", "Example", "Overview", "Purpose" as markers. Use the full unique sentence or heading instead (e.g. "PART 13 — THE ENTIRE BOOK IN ONE FLOW" instead of "Conclusion").`;
      }
    }
    reminder = `

CRITICAL RETRY REMINDER:${errorNudge}
- Your response MUST be a bare JSON array. Do NOT wrap it in an object like {"sections":[...]}.
- Do NOT omit the "title" field from any element.
- The very first character of your response must be [. No markdown fences. No commentary. Only the JSON array.`;
  }

  return `You are a hierarchical document structure parser.

Your ONLY job is to detect the ORIGINAL structural hierarchy EXACTLY as written.

CRITICAL:
- DO NOT reorganize concepts
- DO NOT optimize pedagogy
- DO NOT regroup semantically related regions
- DO NOT summarize
- DO NOT merge distant concepts
- DO NOT create new hierarchy
- DO NOT improve the text

You MUST preserve the ORIGINAL progression EXACTLY.

Your task is ONLY to detect:
- PART boundaries
- UNIT boundaries
- CHAPTER boundaries
- SECTION boundaries
- major subsection transitions
- ALL CAPS headings
- numbered hierarchy
- markdown headings
- explicit structural shifts

IMPORTANT:
Large coherent regions are preferred over tiny semantic fragments.

NEVER isolate:
- single formulas
- single examples
- bridge lines
- transition sentences
- table rows

Keep related content together EXACTLY as written.

STRICT MARKER ANCHOR RULES:
1. VERBATIM COPY: 'start_marker' and 'end_marker' MUST be copied character-for-character EXACTLY from ORIGINAL_TEXT.
2. NO HALLUCINATION/PARAPHRASING: Never paraphrase, summarize, rename, or rewrite markers. They are NOT conceptual labels; they are exact string anchors used directly by JavaScript 'indexOf()'. A single character or whitespace mismatch will crash the parser.
3. HARD CHARACTER LIMIT: Both 'start_marker' and 'end_marker' MUST be under 120 characters in length. Prefer shorter, precise anchors.
4. HIGH DISTINCTIVENESS / UNIQUENESS: Choose highly distinctive and unique boundary strings. Avoid generic boundary names like "Introduction", "Summary", "Conclusion", "Example", "PART", "UNIT", or single numbers unless they are completely unique in the text. Generic/repeated markers will fail validation.
4a. NEVER use bare inline labels as markers. Labels like "Example:", "Result:", "Formula:", "Note:", "Why?", "Meaning:", "Logic:", "Output:" repeat many times and will fail. Instead, use the unique sentence or heading that immediately follows or surrounds them.
5. PREFER STRUCTURAL ANCHORS: Prefer exact numbered headings (e.g., "12. A/B Testing Workflow"), unique all-caps lines, markdown headers, or the first/last unique line of a block.
6. NO EXTRA QUOTES/PUNCTUATION: Do NOT include trailing punctuation (such as colons, dashes, periods) or quotes in markers unless they exist literally in ORIGINAL_TEXT.
7. TITLE FIELD: The 'title' field is optional metadata. It does NOT need to match any markers. Keep the title brief and descriptive.

STRICT CONTIGUITY RULES:
- approx_position should be the approximate character index (integer) where the section starts in ORIGINAL_TEXT.
- Every character of ORIGINAL_TEXT must be covered by exactly one section.
- Sections must be contiguous with no gaps.
- The end_marker of section N and the start_marker of section N+1 must be adjacent or only separated by whitespace in ORIGINAL_TEXT.
- Do NOT leave any heading, line, or paragraph uncovered between two sections.
- Keep formulas, examples, tables, arrows, flows, and bridge sentences with their related section.

Return ONLY valid JSON. Do not include markdown fences. Do not include commentary.
Respond with ONLY a JSON array. The very first character must be [. No markdown fences, no prose, no commentary.${reminder}

JSON shape:
[
  {
    "title": "Brief descriptive title",
    "start_marker": "Exact unique verbatim start boundary string (under 120 chars)",
    "end_marker": "Exact unique verbatim end boundary string (under 120 chars)",
    "approx_position": 1234
  }
]

Below is the text to parse. The prompt ends immediately with this text. Under no circumstances should you generate any boundary marker that references instructions, comments, footers, or JSON metadata format blocks of the prompt itself. Copy markers ONLY from the document content inside ORIGINAL_TEXT below.

ORIGINAL_TEXT:
${text}`;
}

// ─── Text splitting helpers ───────────────────────────────────────────────────

function findBoundary(text, target, min) {
  const paragraph = text.lastIndexOf("\n\n", target);
  if (paragraph >= min) return paragraph + 2;

  const line = text.lastIndexOf("\n", target);
  if (line >= min) return line + 1;

  const sentence = Math.max(
    text.lastIndexOf(". ", target),
    text.lastIndexOf("? ", target),
    text.lastIndexOf("! ", target),
  );
  if (sentence >= min) return sentence + 2;

  return target;
}

function gapRealLength(gap) {
  return gap.replace(/[-–—=\s\d.#*•→|↓]/g, "").trim().length;
}

// ─── FIX: Fuzzy marker search ─────────────────────────────────────────────────
// Gemini sometimes returns markers with collapsed/extra whitespace vs the source.
// Try exact match first; fall back to whitespace-normalised search so a single
// extra space or newline in the model output doesn't blow up the whole anchor.

function findMarkerFuzzy(text, marker, fromIndex) {
  // 1. Exact match (fast path, always preferred)
  const exact = text.indexOf(marker, fromIndex);
  if (exact !== -1) return exact;

  // 2. Whitespace-normalised match
  //    Build a version of the text where all runs of whitespace → single space,
  //    find the marker in that, then map back to the original index.
  const normMarker = marker.replace(/\s+/g, " ").trim();
  if (!normMarker) return -1;

  // Walk through the original text keeping a running normalised cursor so we
  // can map a normalised hit position back to the original index.
  let normPos = 0;
  let origPos = 0;
  let normStart = -1; // original index where the current normalised run started
  let normBuf = ""; // normalised characters accumulated so far

  // We only need to search from fromIndex onward
  origPos = fromIndex;

  // Reset normalised buffer to account for the skip
  // (Simplification: just do a linear scan from fromIndex)
  for (let i = fromIndex; i < text.length; i++) {
    const ch = text[i];
    const isWs = /\s/.test(ch);

    if (isWs) {
      if (normBuf.length === 0 || normBuf[normBuf.length - 1] !== " ") {
        normBuf += " ";
      }
    } else {
      normBuf += ch;
    }

    // Check if normBuf ends with normMarker
    if (normBuf.length >= normMarker.length) {
      const tail = normBuf.slice(normBuf.length - normMarker.length);
      if (tail === normMarker) {
        // Walk back in original text to find where this match began.
        // FIX: guard was `j < i` which is always true on the first char, so
        // duplicate-space skipping fired even for the very first character of
        // the match, causing the returned index to be off by 1.
        // Correct guard is `counted > 0` (only skip a space once we've already
        // accounted for at least one normalised character).
        let matchLen = normMarker.length;
        let j = i;
        let counted = 0;
        while (j >= fromIndex && counted < matchLen) {
          const c = text[j];
          const cNorm = /\s/.test(c) ? " " : c;
          // skip duplicate spaces in normalised view (only after the first char)
          if (cNorm === " " && counted > 0 && /\s/.test(text[j + 1])) {
            j--;
            continue;
          }
          counted++;
          j--;
        }
        return j + 1;
      }
    }
  }

  return -1;
}

// ─────────────────────────────────────────────────────────────────────────────

function extractByMarkers(original, sections) {
  const final = [];
  let lastIndex = 0;

  for (const section of sections) {
    const searchStart = Math.max(
      lastIndex,
      (section.approx_position || 0) - 2000,
    );

    // FIX: use fuzzy search instead of plain indexOf so whitespace differences
    // in Gemini's marker output don't cause the whole anchor to fall back.
    let start = findMarkerFuzzy(original, section.start_marker, searchStart);
    if (start === -1)
      start = findMarkerFuzzy(original, section.start_marker, lastIndex);
    if (start === -1)
      throw new Error(
        `Could not find start_marker "${section.start_marker}" for section: "${section.title}"`,
      );
    if (start < lastIndex)
      throw new Error(`Overlap detected in "${section.title}"`);

    if (start > lastIndex) {
      const gap = original.slice(lastIndex, start);
      const realLen = gapRealLength(gap);

      if (realLen > GAP_ABSORB_THRESHOLD) {
        throw new Error(
          `Gap detected before "${section.title}" (${realLen} real chars — too large to absorb)`,
        );
      }

      if (final.length > 0 && gap.length > 0) {
        final[final.length - 1] = {
          ...final[final.length - 1],
          content: final[final.length - 1].content + gap,
        };
      }
    }

    const effectiveStart =
      final.length === 0 && start > lastIndex ? lastIndex : start;
    const maxSearch = start + WINDOW_CHARS;

    // FIX: fuzzy end_marker search too
    let endMarkerIndex = findMarkerFuzzy(original, section.end_marker, start);
    if (endMarkerIndex === -1)
      throw new Error(
        `Could not find end_marker "${section.end_marker}" for section: "${section.title}"`,
      );
    if (endMarkerIndex > maxSearch)
      throw new Error(`end_marker matched too far ahead in "${section.title}"`);

    const end = endMarkerIndex + section.end_marker.length;
    final.push({
      title: section.title,
      content: original.slice(effectiveStart, end),
    });
    lastIndex = end;
  }

  if (lastIndex < original.length && final.length > 0) {
    const tail = original.slice(lastIndex);
    const realTailLen = gapRealLength(tail);

    if (realTailLen > GAP_ABSORB_THRESHOLD) {
      throw new Error(
        `Tail gap after last section is too large (${realTailLen} real chars)`,
      );
    }

    if (tail.length > 0) {
      final[final.length - 1] = {
        ...final[final.length - 1],
        content: final[final.length - 1].content + tail,
      };
    }
  }

  return final;
}

function splitIntoWindows(text) {
  if (text.length <= MAX_INPUT_CHARS) return [text];

  const windows = [];
  let start = 0;

  while (start < text.length) {
    const targetEnd = Math.min(start + WINDOW_CHARS, text.length);
    const minEnd = Math.min(start + Math.floor(WINDOW_CHARS * 0.75), targetEnd);
    const end =
      targetEnd === text.length
        ? targetEnd
        : findBoundary(text, targetEnd, minEnd);

    windows.push(text.slice(start, end));
    if (end === text.length) break;

    const nextStartTarget = Math.max(0, end - OVERLAP_CHARS);
    const minStart = Math.max(0, end - OVERLAP_CHARS * 2);
    const nextStart = findBoundary(text, nextStartTarget, minStart);

    start = nextStart < end ? nextStart : Math.max(0, end - OVERLAP_CHARS);
  }

  return windows;
}

function normalizeForCompare(text) {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function overlapLength(previous, next) {
  const prev = normalizeForCompare(previous);
  const incoming = normalizeForCompare(next);
  const max = Math.min(prev.length, incoming.length, OVERLAP_CHARS * 2);

  for (let len = max; len >= 200; len -= 50) {
    if (prev.slice(-len) === incoming.slice(0, len)) return len;
  }

  return 0;
}

function rawOverlapLength(previous, next) {
  const max = Math.min(previous.length, next.length, OVERLAP_CHARS * 2);

  for (let len = max; len >= 200; len--) {
    if (previous.slice(-len) === next.slice(0, len)) return len;
  }

  return 0;
}

// ─── Core partition logic ─────────────────────────────────────────────────────

async function partitionWindow(text, callLLM, label = "input") {
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const prompt = buildPrompt(text, attempt, lastError);
      const responseText = await callLLM(prompt);
      const parsed = parsePartitionJson(responseText);

      let currentLastIndex = 0;
      for (const item of parsed) {
        const startMarker = item.start_marker;
        const endMarker = item.end_marker;

        if (isGenericMarker(startMarker)) {
          throw new Error(
            `start_marker "${startMarker}" (section: "${item.title}") is too generic. Choose a more unique boundary anchor.`,
          );
        }

        const startIdx = findMarkerFuzzy(text, startMarker, currentLastIndex);
        if (startIdx === -1) {
          throw new Error(
            `start_marker "${startMarker}" (section: "${item.title}") not found in source text after previous section end index ${currentLastIndex}.`,
          );
        }

        if (isGenericMarker(endMarker)) {
          throw new Error(
            `end_marker "${endMarker}" (section: "${item.title}") is too generic. Choose a more unique boundary anchor.`,
          );
        }

        const endIdx = findMarkerFuzzy(text, endMarker, startIdx);
        if (endIdx === -1) {
          throw new Error(
            `end_marker "${endMarker}" (section: "${item.title}") not found in source text after start_marker.`,
          );
        }

        if (startMarker.length < 12) {
          const earlierOccurrence = text.indexOf(startMarker);
          if (
            earlierOccurrence !== -1 &&
            earlierOccurrence < currentLastIndex - 200
          ) {
            throw new Error(
              `start_marker "${startMarker}" (section: "${item.title}") is too short and ambiguous — appears before the current search position. Choose a longer unique anchor.`,
            );
          }
        }

        if (endMarker.length < 12) {
          const earlierEnd = text.indexOf(endMarker);
          if (earlierEnd !== -1 && earlierEnd < startIdx - 200) {
            throw new Error(
              `end_marker "${endMarker}" (section: "${item.title}") is too short and ambiguous — appears before start_marker. Choose a longer unique anchor.`,
            );
          }
        }

        currentLastIndex = endIdx + endMarker.length;
      }

      return parsed;
    } catch (error) {
      lastError = error;

      if (attempt < MAX_ATTEMPTS) {
        const retryAfterMatch = error.message.match(
          /"retryDelay"\s*:\s*"(\d+)s"/,
        );
        const retryAfterSec = retryAfterMatch
          ? parseInt(retryAfterMatch[1], 10) + 2
          : 0;
        const backoff =
          retryAfterSec * 1000 || 2500 * attempt + Math.random() * 2500;

        console.log(
          `[partitionWindow] ${label} attempt ${attempt} failed: ${error.message}; retrying in ${Math.round(backoff / 1000)}s...`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }

  throw new Error(
    `hierarchicalPartition failed for ${label} after ${MAX_ATTEMPTS} attempts: ${lastError.message}`,
  );
}

function mergeWindowSections(existingSections, incomingSections) {
  if (!existingSections.length) return incomingSections;

  const merged = [...existingSections];
  const last = merged[merged.length - 1];
  let index = 0;

  while (index < incomingSections.length) {
    const incoming = incomingSections[index];
    const rawDuplicateOverlap = rawOverlapLength(
      last.content,
      incoming.content,
    );
    const duplicateOverlap = overlapLength(last.content, incoming.content);

    if (
      rawDuplicateOverlap > 0 &&
      rawDuplicateOverlap < incoming.content.length
    ) {
      incomingSections[index] = {
        ...incoming,
        content: incoming.content.slice(rawDuplicateOverlap).trimStart(),
      };
      break;
    }

    if (duplicateOverlap > 0) {
      const normalizedIncoming = normalizeForCompare(incoming.content);
      if (duplicateOverlap >= normalizedIncoming.length * 0.8) {
        index++;
        continue;
      }
    }

    if (
      normalizeForCompare(last.content).includes(
        normalizeForCompare(incoming.content).slice(0, 500),
      )
    ) {
      index++;
      continue;
    }

    break;
  }

  return merged.concat(incomingSections.slice(index));
}

async function partitionWindowOrFallback(text, callLLM, label, depth = 0) {
  try {
    let sections = await partitionWindow(text, callLLM, label);
    sections = extractByMarkers(text, sections);

    const reconstructed = sections.map((s) => s.content).join("");
    if (
      normalizeForCompare(reconstructed) !==
      normalizeForCompare(text)
    ) {
      throw new Error("Partition validation failed: content mismatch");
    }
    return sections;
  } catch (error) {
    if (text.length <= 1500) {
      console.log(
        `[hierarchicalPartition] ${label} (depth ${depth}) AI failed or text is tiny (${text.length} chars). Returning as leaf.`
      );
      return [{ title: `${label} (leaf)`, content: text }];
    }

    console.log(
      `[hierarchicalPartition] ${label} (depth ${depth}) AI attempt failed: ${error.message}`
    );
    console.log(`[hierarchicalPartition] Splitting ${label} in half and retrying AI on each sub-window...`);

    const mid = Math.floor(text.length / 2);
    const minEnd = Math.floor(text.length * 0.35);
    const boundary = findBoundary(text, mid, minEnd);

    const part1 = text.slice(0, boundary);
    const part2 = text.slice(boundary);

    console.log(`[hierarchicalPartition] Sub-window 1: ${part1.length} chars, Sub-window 2: ${part2.length} chars`);

    const sections1 = await partitionWindowOrFallback(part1, callLLM, `${label}.1`, depth + 1);
    const sections2 = await partitionWindowOrFallback(part2, callLLM, `${label}.2`, depth + 1);

    return mergeWindowSections(sections1, sections2);
  }
}

async function hierarchicalPartition(text, callLLM) {
  if (typeof text !== "string") {
    throw new TypeError("hierarchicalPartition(text) expects a string.");
  }

  if (!text.trim()) return [];

  const anchors = extractParts(text);
  if (anchors.length === 0) return [text];

  const expandedAnchors = [];

  for (const anchor of anchors) {
    if (anchor.length <= MAX_INPUT_CHARS) {
      expandedAnchors.push(anchor);
    } else {
      expandedAnchors.push(...splitIntoWindows(anchor));
    }
  }

  let sections = [];

  for (let i = 0; i < expandedAnchors.length; i++) {
    const label = `anchor ${i + 1}/${expandedAnchors.length}`;

    if (i > 0) {
      await new Promise((r) => setTimeout(r, 3500));
    }

    const anchorSections = await partitionWindowOrFallback(expandedAnchors[i], callLLM, label, 0);
    sections = mergeWindowSections(sections, anchorSections);
  }

  return sections;
}

export { hierarchicalPartition };
