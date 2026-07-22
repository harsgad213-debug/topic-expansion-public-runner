const fs = require("fs");
const path = require("path");
const { fetch, ProxyAgent } = require("undici");

const GITHUB_ENDPOINT = "https://models.github.ai/inference/chat/completions";
const GROQ_ENDPOINT   = "https://api.groq.com/openai/v1/chat/completions";

const GROQ_MODELS_DEFAULT = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'llama-3.3-70b-versatile',
  'qwen/qwen3.6-27b',
  'groq/compound',
];
const PROMPT_TYPES = new Set(["full_book", "unit_overview", "knowledge_map"]);
const CHUNK_CHARS = Number(process.env.GITHUB_PHASE1_CHUNK_CHARS || 12000);
const CHUNK_OVERLAP = Number(process.env.GITHUB_PHASE1_CHUNK_OVERLAP || 800);
const SUMMARY_CONCURRENCY = Number(process.env.GITHUB_PHASE1_SUMMARY_CONCURRENCY || 4);

const MODEL_LIMITS = new Map([
  ["openai/gpt-4.1", 8000],
  ["openai/gpt-4o", 8000],
  ["openai/gpt-4.1-mini", 8000],
  ["openai/gpt-4o-mini", 8000],
  ["meta/llama-3.3-70b-instruct", 8000],
]);

function nonNegativeEnvInt(name) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return 0;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

let totalRequests = 0;
let totalFailures = 0;
const metadataFileCache = new Map();

// --- RESILIENCY STATES ---
const keyProxyMap = new Map();
const proxyHealth = new Map();
const deadProxies = new Set();
const keyUaMap = new Map();
const inFlightBucket = new Map();
const coolingBucket = new Map();
const tpdExhausted = new Map();
const keyDailyUsage = new Map();
const rateLimiters = new Map();
const proxyAgents = new Map();
let ALL_BUCKETS = [];
let bucketsInitialized = false;

const UAs = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'python-requests/2.31.0',
  'PostmanRuntime/7.36.0',
  'curl/8.4.0',
  'groq-python/0.4.2'
];

class RateLimiter {
  constructor(max, refillPerSec) {
    this.max = max; this.tokens = max; this.refill = refillPerSec;
    this.last = Date.now();
  }
  canConsume() {
    const now = Date.now();
    const elapsed = (now - this.last) / 1000;
    this.tokens = Math.min(this.max, this.tokens + elapsed * this.refill);
    this.last = now;
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    return false;
  }
}

function initBuckets(keys, models) {
  if (bucketsInitialized) return;
  
  // Try load proxies
  let proxyList = [];
  try {
    const pPath = path.join(process.cwd(), 'proxies.txt');
    if (fs.existsSync(pPath)) {
      proxyList = fs.readFileSync(pPath, 'utf8').split('\n').map(l => l.trim()).filter(l => l.length > 0);
      console.log(`[Init] Loaded ${proxyList.length} proxies from proxies.txt`);
    }
  } catch(e) {}

  // --- GitHub buckets (use proxies) ---
  const groqOnly = process.env.GROQ_ONLY === 'true';
  if (!groqOnly) {
    for (const k of keys) {
      if (proxyList.length > 0) {
        const pIdx = Math.abs(k.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)) % proxyList.length;
        keyProxyMap.set(k, proxyList[pIdx]);
      }
      keyUaMap.set(k, UAs[Math.floor(Math.random() * UAs.length)]);
      for (const m of models) {
        ALL_BUCKETS.push({ provider: 'github', key: k, model: m, id: `github:${k}:${m}` });
      }
    }
  } else {
    console.log('[Init] GROQ_ONLY=true — skipping GitHub buckets.');
  }

  // --- Groq buckets (same proxy + resiliency stack as GitHub) ---
  const groqKeysRaw = process.env.GROQ_KEYS || '';
  const groqKeys = groqKeysRaw.split(/[\n,;]+/).map(k => k.trim()).filter(k => k.startsWith('gsk_'));
  const groqModelsRaw = process.env.GROQ_PHASE1_MODELS || GROQ_MODELS_DEFAULT.join(',');
  const groqModels = groqModelsRaw.split(',').map(m => m.trim()).filter(Boolean);
  if (groqKeys.length > 0) {
    for (const k of groqKeys) {
      // Assign sticky proxy (same deterministic logic as GitHub keys)
      if (proxyList.length > 0) {
        const pIdx = Math.abs(k.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)) % proxyList.length;
        keyProxyMap.set(k, proxyList[pIdx]);
      }
      keyUaMap.set(k, UAs[Math.floor(Math.random() * UAs.length)]);
      for (const m of groqModels) {
        ALL_BUCKETS.push({ provider: 'groq', key: k, model: m, id: `groq:${k}:${m}` });
      }
    }
    console.log(`[Init] Loaded ${groqKeys.length} Groq keys × ${groqModels.length} models = ${groqKeys.length * groqModels.length} Groq buckets.`);
  }

  // Fisher-Yates shuffle ALL_BUCKETS
  for (let i = ALL_BUCKETS.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ALL_BUCKETS[i], ALL_BUCKETS[j]] = [ALL_BUCKETS[j], ALL_BUCKETS[i]];
  }
  bucketsInitialized = true;
  console.log(`[Init] Initialized and shuffled ${ALL_BUCKETS.length} total buckets.`);
}


function safeSegment(value) {
  return String(value || "untitled")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readText(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function stripMarkdownFence(text) {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/^```(?:[a-zA-Z0-9_-]+)?\s*\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

function normalizeGeneratedOutput(text) {
  let cleaned = stripMarkdownFence(text);
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  cleaned = cleaned
    .split("\n")
    .filter((line) => !line.trim().startsWith("```"))
    .join("\n")
    .replace(/^#{1,4}\s+/gm, "");
  const lines = cleaned.split("\n");
  while (lines.length && !lines[0].trim()) lines.shift();
  if (lines[0]?.trim().startsWith("# ")) {
    lines.shift();
    while (lines.length && !lines[0].trim()) lines.shift();
  }
  return lines.join("\n").trim();
}

const STOPWORDS = new Set(
  `
  a about above after again against all also am an and any are as at be because been before being below between both but by
  can cannot could did do does doing down during each few for from further had has have having he her here hers herself him
  himself his how i if in into is it its itself just me more most my myself no nor not of off on once only or other our ours
  ourselves out over own same she should so some such than that the their theirs them themselves then there these they this
  those through to too under until up very was we were what when where which while who whom why will with you your yours
  yourself yourselves course courses lecture lectures video videos section sections module modules lesson lessons transcript
  transcripts okay ok right really going gonna want need let lets now first second third next one two three four five six
  seven eight nine ten udemy instructor students example examples using used use make makes get gets got see look like know
  think learn learning data dataset datasets file files code coding python r business user users
  `.split(/\s+/).filter(Boolean),
);

function normalizeForMatch(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/a\s*\/\s*b/g, "ab")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^a-z0-9+#.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulTokens(text) {
  return normalizeForMatch(text)
    .split(/\s+/)
    .filter((token) => {
      if (!token || STOPWORDS.has(token)) return false;
      if (/^\d+$/.test(token)) return false;
      if (token.length < 3 && !["ab", "ai", "ml", "bi"].includes(token)) return false;
      return true;
    });
}

function ngrams(items, n) {
  const out = [];
  for (let i = 0; i <= items.length - n; i++) out.push(items.slice(i, i + n).join(" "));
  return out;
}

function extractPhrases(text, limit = 80) {
  const items = meaningfulTokens(text);
  const counts = new Map();
  for (const n of [1, 2, 3]) {
    for (const phrase of ngrams(items, n)) {
      const parts = phrase.split(" ");
      if (parts.length > 1 && parts.some((part) => part.length < 3 && part !== "ab")) continue;
      counts.set(phrase, (counts.get(phrase) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([phrase, count]) => ({
      phrase,
      count,
      score: count * (1 + phrase.split(" ").length * 0.6),
    }))
    .filter((item) => item.count >= (item.phrase.split(" ").length === 1 ? 3 : 2))
    .sort((a, b) => b.score - a.score || b.phrase.length - a.phrase.length)
    .slice(0, limit);
}

function phraseCoverage(phrases, targetText) {
  const target = normalizeForMatch(targetText);
  const rows = phrases.map((item) => ({
    phrase: item.phrase,
    covered: target.includes(item.phrase),
  }));
  const covered = rows.filter((row) => row.covered).length;
  return {
    ratio: rows.length ? covered / rows.length : 1,
    missing: rows.filter((row) => !row.covered).slice(0, 16).map((row) => row.phrase),
  };
}

function baselinePhraseCues(baseline, limit = 60) {
  if (!baseline) return "";
  return extractPhrases(baseline, limit)
    .map((item) => item.phrase)
    .join(", ");
}

function endingQuality(text) {
  const nonEmpty = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const lastLine = nonEmpty[nonEmpty.length - 1] || "";
  const terminal = /[.!?)]$/.test(lastLine) || /^end of\b/i.test(lastLine);
  const allowedNonTerminal = /^upload\b/i.test(lastLine);
  return {
    last_line: lastLine,
    suspicious: !terminal && !allowedNonTerminal,
  };
}

function benchmarkLabels(baseline) {
  if (!baseline) return [];
  return baselineOutlineCues(baseline)
    .split("\n")
    .map((line) =>
      line
        .replace(/^PART\s+\d+\s*[:.-]?\s*/i, "")
        .replace(/^\d+[\.)]\s+/, "")
        .trim(),
    )
    .filter((line) => meaningfulTokens(line).length >= 2)
    .slice(0, 40);
}

function missingBenchmarkLabels(baseline, output) {
  const normalized = normalizeForMatch(output);
  return benchmarkLabels(baseline).filter((label) => {
    const tokens = meaningfulTokens(label);
    if (!tokens.length) return false;
    const matched = tokens.filter((token) => normalized.includes(token)).length;
    return matched / tokens.length < 0.7;
  });
}

function localParityIssues(type, output, baseline) {
  if (!baseline) return [];
  const issues = [];
  const baselineLines = baseline.split("\n").length || 1;
  const outputLines = output.split("\n").length;
  const lineRatio = outputLines / baselineLines;
  const baselineExamples = (baseline.match(/\bexample\b/gi) || []).length;
  const outputExamples = (output.match(/\bexample\b/gi) || []).length;
  const exampleRatio = baselineExamples ? outputExamples / baselineExamples : 1;
  const baselineParts = (baseline.match(/\bPART\s+\d+\b/gi) || []).length;
  const outputParts = (output.match(/\bPART\s+\d+\b/gi) || []).length;
  const partRatio = baselineParts ? outputParts / baselineParts : 1;
  const baselineArrows = (baseline.match(/->|\u2192/g) || []).length;
  const outputArrows = (output.match(/->|\u2192/g) || []).length;
  const arrowRatio = baselineArrows ? outputArrows / baselineArrows : 1;
  const lengthRatio = output.length / baseline.length;
  const codeFences = (output.match(/^```/gm) || []).length;
  const headingMarks = (output.match(/^#{1,4}\s+/gm) || []).length;
  const coverage = phraseCoverage(extractPhrases(baseline, 80), output);
  const ending = endingQuality(output);
  const missingLabels = type === "knowledge_map"
    ? missingBenchmarkLabels(baseline, output)
    : [];

  if (lengthRatio < 0.75) {
    issues.push(
      `Output is too short (${lengthRatio.toFixed(2)} of benchmark). Expand to match benchmark depth without filler.`,
    );
  }
  if (lengthRatio > 1.35) {
    issues.push(
      `Output is too long (${lengthRatio.toFixed(2)} of benchmark). Condense to match benchmark length while preserving coverage and line-by-line teaching shape.`,
    );
  }
  if (coverage.ratio < 0.65) {
    issues.push(
      `Baseline phrase coverage is ${coverage.ratio.toFixed(2)}. Add or preserve these benchmark concepts where supported: ${coverage.missing.join(", ")}.`,
    );
  }
  if (ending.suspicious) {
    issues.push(
      `Output appears to end abruptly. Last line: "${ending.last_line}". Finish with a complete closing sentence or final summary.`,
    );
  }
  if (lineRatio < 0.45) {
    issues.push(
      `Line-density is too compressed (${lineRatio.toFixed(2)} of benchmark). Match the ChatGPT UI shape with many short teaching lines, separated formulas, separated arrows, and standalone labels.`,
    );
  }
  if (missingLabels.length) {
    issues.push(
      `Missing benchmark map labels: ${missingLabels.slice(0, 12).join(", ")}. Add these labels exactly as plain standalone lines when supported.`,
    );
  }
  if (exampleRatio < 0.6) {
    issues.push(
      `Example count is too low (${exampleRatio.toFixed(2)} of benchmark). Add concrete worked examples and mini-scenarios from the evidence.`,
    );
  }
  if (type === "knowledge_map" && partRatio < 0.7) {
    issues.push(
      `Knowledge map lost PART section structure (${outputParts}/${baselineParts}). Restore plain PART labels and major benchmark map headings.`,
    );
  }
  if (type === "knowledge_map" && arrowRatio < 0.7) {
    issues.push(
      `Knowledge map has too few relationship arrows (${outputArrows}/${baselineArrows}). Restore visual relationship flow using plain text arrows.`,
    );
  }
  if (codeFences > 0) {
    issues.push("Remove Markdown code fences. Plain text maps must not be fenced.");
  }
  if (headingMarks > 0) {
    issues.push("Remove Markdown # headings. Use plain standalone section labels like the ChatGPT UI output.");
  }
  return issues;
}

function extractJson(text) {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function normalizeModels(githubModels) {
  const envModels = (process.env.GITHUB_PHASE1_MODELS || "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  if (envModels.length) return envModels;

  const available = Array.isArray(githubModels) ? githubModels : [];
  const preferred = ["openai/gpt-4.1", "openai/gpt-4o"].filter((model) =>
    available.includes(model),
  );
  if (preferred.length) return preferred;
  return available.length ? available.slice(0, 2) : ["openai/gpt-4.1", "openai/gpt-4o"];
}

function discoverTranscriptFiles(transcriptsDir, files) {
  return files
    .filter((name) => name.toLowerCase().endsWith(".txt"))
    .sort()
    .map((name) => {
      const fullPath = path.join(transcriptsDir, name);
      const text = readText(fullPath);
      return {
        source_id: `source_${safeSegment(name.replace(/\.txt$/i, ""))
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "")}`,
        filename: name,
        path: fullPath,
        char_count: text.length,
        approx_tokens: Math.ceil(text.length / 4),
        title: name
          .replace(/\.txt$/i, "")
          .replace(/[_-]+/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
        text,
      };
    });
}

function scoreNameAgainstTitle(filePath, title) {
  const lower = path.basename(filePath).toLowerCase();
  const wanted = String(title || "")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !["and", "with", "the", "for"].includes(w));
  let score = 0;
  for (const word of wanted) {
    if (lower.includes(word)) score++;
  }
  return score;
}

function discoverMetadataFiles(metadataDir) {
  if (!metadataDir || !fs.existsSync(metadataDir)) return [];
  if (metadataFileCache.has(metadataDir)) return metadataFileCache.get(metadataDir);

  const files = [];
  const stack = [metadataDir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (![".git", "node_modules", "__pycache__"].includes(entry.name)) stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith("_context.json")) {
        files.push(full);
      }
    }
  }
  metadataFileCache.set(metadataDir, files);
  return files;
}

function findMetadataForSource(source, metadataDir) {
  const candidates = discoverMetadataFiles(metadataDir)
    .map((file) => ({ file, score: scoreNameAgainstTitle(file, source.title) }))
    .filter((item) => item.score >= 2)
    .sort((a, b) => b.score - a.score);
  if (!candidates.length) return null;

  try {
    const raw = JSON.parse(readText(candidates[0].file));
    return {
      metadata_path: candidates[0].file,
      course_id: raw.course_id,
      title: raw.title,
      headline: raw.headline,
      objectives: raw.objectives || raw.what_you_will_learn_data?.items || [],
      category: raw.category,
      subcategory: raw.subcategory,
      topics: raw.topics || [],
      sections: (raw.curriculum_sections || []).map((section) => ({
        index: section.index,
        title: section.title,
        lectures: (section.lectures || []).map((lecture) => ({
          index: lecture.index,
          title: lecture.title,
        })),
      })),
    };
  } catch {
    return null;
  }
}

function splitIntoChunks(source) {
  const chunks = [];
  let i = 0;
  let idx = 0;
  while (i < source.text.length) {
    let end = Math.min(source.text.length, i + CHUNK_CHARS);
    if (end < source.text.length) {
      const boundary = source.text.lastIndexOf("\n\n", end);
      if (boundary > i + CHUNK_CHARS * 0.65) end = boundary;
    }
    const text = source.text.slice(i, end).trim();
    if (text) {
      chunks.push({
        chunk_id: `${source.source_id}_chunk_${String(idx).padStart(3, "0")}`,
        source_id: source.source_id,
        filename: source.filename,
        chunk_index: idx,
        char_start: i,
        char_end: end,
        char_count: text.length,
        text,
      });
      idx++;
    }
    if (end >= source.text.length) break;
    i = Math.max(end - CHUNK_OVERLAP, i + 1);
  }
  return chunks;
}

function wordsFromTopic(topicName) {
  return String(topicName || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2);
}

function evidenceTermsFor(topicName, type) {
  const topicWords = wordsFromTopic(topicName);
  const common = [
    ...topicWords,
    "definition",
    "example",
    "workflow",
    "process",
    "project",
    "formula",
    "metric",
    "tool",
    "dashboard",
    "analysis",
    "hypothesis",
    "model",
    "implementation",
    "mistake",
    "decision",
    "business",
  ];
  if (type === "knowledge_map") {
    return [...topicWords, "relationship", "dependency", "map", "flow", ...common];
  }
  if (type === "unit_overview") {
    return [...topicWords, "what is", "why", "practical", "concept", ...common];
  }
  return [...topicWords, "complete", "journey", "step", "overview", ...common];
}

function countTerm(text, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (text.match(new RegExp(escaped, "gi")) || []).length;
}

function scoreChunkForTerms(text, terms) {
  const lower = text.toLowerCase();
  const matchedTerms = [];
  let score = 0;
  for (const term of terms) {
    const count = countTerm(lower, term.toLowerCase());
    if (count) {
      matchedTerms.push(term);
      score += Math.min(count, 4) * Math.max(1, term.split(/\s+/).length);
    }
  }
  return { score, matchedTerms };
}

function snippetAroundBestTerm(text, terms, maxChars = 720) {
  const lower = text.toLowerCase();
  let bestIndex = -1;
  let bestTermLength = 0;
  for (const term of terms) {
    const index = lower.indexOf(term.toLowerCase());
    if (index >= 0) {
      bestIndex = index;
      bestTermLength = term.length;
      break;
    }
  }
  if (bestIndex < 0) return text.slice(0, maxChars).replace(/\s+/g, " ").trim();
  const start = Math.max(0, Math.floor(bestIndex - maxChars * 0.38));
  const end = Math.min(text.length, start + maxChars + bestTermLength);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function selectRawEvidenceSnippets(sources, topicName, type) {
  const terms = evidenceTermsFor(topicName, type);
  const snippets = [];
  for (const source of sources) {
    const chunks = splitIntoChunks(source);
    const selected = chunks
      .map((chunk) => ({ ...chunk, ...scoreChunkForTerms(chunk.text, terms) }))
      .filter((chunk) => chunk.score > 0)
      .sort((a, b) => b.score - a.score || a.chunk_index - b.chunk_index)
      .slice(0, 3);
    for (const chunk of selected) {
      snippets.push({
        source_id: source.source_id,
        filename: source.filename,
        title: source.title,
        chunk_id: chunk.chunk_id,
        chunk_index: chunk.chunk_index,
        score: chunk.score,
        matched_terms: chunk.matchedTerms.slice(0, 10),
        snippet: snippetAroundBestTerm(chunk.text, chunk.matchedTerms, 640),
      });
    }
  }
  return snippets;
}

function buildSourcePackage(topicName, topicDir, sources, metadataDir) {
  const enriched = sources.map((source) => {
    const metadata = findMetadataForSource(source, metadataDir);
    return {
      source_id: source.source_id,
      filename: source.filename,
      title: metadata?.title || source.title,
      char_count: source.char_count,
      approx_tokens: source.approx_tokens,
      metadata: metadata
        ? {
            course_id: metadata.course_id,
            metadata_path: metadata.metadata_path,
            headline: metadata.headline,
            objectives: metadata.objectives,
            category: metadata.category,
            subcategory: metadata.subcategory,
            topics: metadata.topics,
            sections: metadata.sections.slice(0, 30),
          }
        : null,
    };
  });

  return {
    topic: topicName,
    topic_dir: topicDir,
    generated_at: new Date().toISOString(),
    source_count: enriched.length,
    total_chars: enriched.reduce((sum, source) => sum + source.char_count, 0),
    total_approx_tokens: enriched.reduce((sum, source) => sum + source.approx_tokens, 0),
    sources: enriched,
  };
}

function profileFor(type) {
  if (type === "full_book") {
    return {
      name: "full_book",
      instruction:
        "Explain the full book/course content as one connected learning journey. Build a complete map of the topic, then explain the major parts in teaching order with examples.",
      structure:
        "Opening synthesis, whole-book journey map, PART-style sections, core ideas, process flow, examples, final integrated summary.",
      mustCover:
        "Cover all transcript-backed source contributions, the practical workflow, examples, terms, tools, formulas, decisions, and advanced caveats where the source material supports them.",
      style:
        "Start directly with a teaching sentence, not a title. Use short instructional lines, simple arrows, concrete examples, and PART sections. Make the output feel like a guided walkthrough.",
      targetLength: 9500,
    };
  }
  if (type === "unit_overview") {
    return {
      name: "unit_overview",
      instruction:
        "Explain the complete unit from the source material. Define concepts simply, map how the unit fits the larger topic, and include examples.",
      structure:
        "Opening unit framing, 12-20 numbered concepts, simple definitions, practical examples, formulas/metrics where present, common mistakes, final summary.",
      mustCover:
        "Make the unit practical, not textbook-only. Include definitions, relationships, formulas or methods where present, examples, mistakes, and decisions supported by transcripts.",
      style:
        "Start directly with a teaching sentence, not a title. Use numbered sections with short lines, examples, formulas written step by step, and simple cause-and-effect explanations.",
      targetLength: 10500,
    };
  }
  return {
    name: "knowledge_map",
    instruction:
      "Create a knowledge map of the whole topic. Emphasize relationships, dependencies, flows, hierarchy, and how concepts connect.",
    structure:
      "Opening story, plain-text master map, relationship/dependency sections, concept hierarchy, examples, final one-sentence map.",
    mustCover:
      "Show the topic as a connected map across sources: prerequisites, flows, branches, dependencies, practice examples, decisions, and advanced topics supported by evidence.",
    style:
      "Start directly with a teaching sentence, not a title. Use plain-text maps with arrows, compact relationship sections, short explanatory lines, and visible dependencies between concepts.",
    targetLength: 10000,
  };
}

function manifestMarkdown(pkg) {
  const lines = [`Topic: ${pkg.topic}`, `Sources: ${pkg.source_count}`, `Total characters: ${pkg.total_chars}`, ""];
  for (const source of pkg.sources) {
    lines.push(`- ${source.source_id}: ${source.title}`);
    lines.push(`  file: ${source.filename}`);
    lines.push(`  chars: ${source.char_count}`);
    if (source.metadata?.headline) lines.push(`  headline: ${source.metadata.headline}`);
    if (source.metadata?.objectives?.length) {
      lines.push(`  objectives: ${source.metadata.objectives.slice(0, 6).join("; ")}`);
    }
    if (source.metadata?.sections?.length) {
      lines.push(
        `  sections: ${source.metadata.sections
          .slice(0, 14)
          .map((section) => `${section.index}. ${section.title}`)
          .join(" | ")}`,
      );
    }
  }
  return lines.join("\n");
}

function packTextItems(items, maxChars, render) {
  const batches = [];
  let current = [];
  let currentChars = 0;
  for (const item of items) {
    const text = render(item);
    if (current.length && currentChars + text.length > maxChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(item);
    currentChars += text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function callGitHub(keys, models, messages, options = {}) {
  if (!Array.isArray(keys) || !keys.length) {
    throw new Error("No GitHub keys available for GitHub Phase 1 synthesis.");
  }
  
  initBuckets(keys, models);
  
  const maxTokens = options.maxTokens || 1600;
  const temperature = options.temperature ?? 0.2;
  const inputChars = messages.reduce((sum, message) => sum + String(message.content || "").length, 0);
  const estimatedTokens = Math.ceil(inputChars / 4) + maxTokens;
  
  const usableBuckets = ALL_BUCKETS.filter(b => estimatedTokens < (MODEL_LIMITS.get(b.model) || 8000));
  // Fallback: if token-limit filtering removed all buckets, use all (let the model reject if needed)
  const bucketsToUse = usableBuckets.length > 0 ? usableBuckets : ALL_BUCKETS;

  // Attempt as many times as there are buckets — cycle through all of them
  const attempts = bucketsToUse.length;
  let lastError = null;
  let waitLoops = 0;

  for (let attempt = 0; attempt < attempts; attempt++) {
    let selectedBucket = null;
    let selectedKey = null;
    let selectedModel = null;
    let selectedProvider = 'github';
    
    // Smart Bucket Selector
    for (let tryCount = 0; tryCount < bucketsToUse.length * 2; tryCount++) {
      const now = Date.now();
      const idx = (Math.floor(Math.random() * bucketsToUse.length) + tryCount) % bucketsToUse.length;
      const b = bucketsToUse[idx];
      const bId = b.id;
      
      if ((keyDailyUsage.get(bId) || 0) >= 180) continue; // Soft daily cap
      if (tpdExhausted.get(bId)) continue; // Exhausted
      if ((inFlightBucket.get(bId) || 0) > 0) continue; // In-flight concurrency
      if ((coolingBucket.get(bId) || 0) > now) continue; // Cooling down
      
      if (!rateLimiters.has(bId)) rateLimiters.set(bId, new RateLimiter(2, 0.5));
      if (!rateLimiters.get(bId).canConsume()) continue;
      
      selectedBucket = bId;
      selectedKey = b.key;
      selectedModel = b.model;
      selectedProvider = b.provider || 'github';
      break;
    }

    if (!selectedBucket) {
      waitLoops++;
      if (waitLoops > 120) {
        throw lastError || new Error("All buckets permanently exhausted or cooling — giving up.");
      }
      // Wait for buckets to cool down or rate limits to refill
      await new Promise(r => setTimeout(r, 500));
      attempt--; // don't count wait loop against retry attempts
      continue;
    }
    waitLoops = 0; // reset on successful selection
    
    totalRequests++;
    inFlightBucket.set(selectedBucket, (inFlightBucket.get(selectedBucket) || 0) + 1);
    
    let dispatcher = undefined;
    // All providers use proxy + UA rotation for key safety
    const proxyStr = keyProxyMap.get(selectedKey);
    if (proxyStr && !deadProxies.has(proxyStr)) {
      if (!proxyAgents.has(proxyStr)) {
        proxyAgents.set(proxyStr, new ProxyAgent({
          uri: `http://${proxyStr}`,
          connections: 10,
          requestTls: { rejectUnauthorized: false },
          connect: { timeout: 10000 }
        }));
      }
      dispatcher = proxyAgents.get(proxyStr);
      const proxyHost = proxyStr.includes('@') ? proxyStr.split('@')[1] : proxyStr;
      console.log(`[REQ #${totalRequests}][${selectedProvider}] via proxy ${proxyHost} | key=...${selectedKey.slice(-4)} | model=${selectedModel}`);
    } else {
      console.log(`[REQ #${totalRequests}][${selectedProvider}] DIRECT | key=...${selectedKey.slice(-4)} | model=${selectedModel}`);
    }
    const endpoint = selectedProvider === 'groq' ? GROQ_ENDPOINT : GITHUB_ENDPOINT;
    
    const userAgent = keyUaMap.get(selectedKey) || "Mozilla/5.0";

    try {
      // Jitter to prevent synchronized bursts
      await new Promise(r => setTimeout(r, Math.random() * 250));

      const res = await fetch(endpoint, {
        method: "POST",
        dispatcher,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${selectedKey}`,
          "User-Agent": userAgent
        },
        body: JSON.stringify({
          model: selectedModel,
          messages,
          // Qwen3 reasoning models consume tokens for thinking before responding;
          // multiply max_tokens by 3 to ensure thinking finishes and content is produced
          max_tokens: selectedModel.includes('qwen') ? maxTokens * 3 : maxTokens,
          temperature,
        }),
        signal: AbortSignal.timeout(options.timeoutMs || 180000),
      });

      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }

      if (!res.ok) {
        lastError = new Error(`[${selectedProvider}] HTTP ${res.status}: ${JSON.stringify(data).slice(0, 400)}`);
        totalFailures++;

        if (res.status === 429) {
          const bodyText = (text || "").toLowerCase();
          // GitHub TPD exhaustion
          if (selectedProvider === 'github' && (bodyText.includes("tokens per day") || res.headers.get("x-ratelimit-type") === "UserByModelByDay")) {
            tpdExhausted.set(selectedBucket, true);
          } else {
            // Use retry-after if provided, else 60s for GitHub, 30s for Groq
            const retryAfter = res.headers.get("retry-after");
            const defaultCool = selectedProvider === 'groq' ? 30000 : 60000;
            const cooldownMs = retryAfter ? parseFloat(retryAfter) * 1000 : defaultCool;
            coolingBucket.set(selectedBucket, Date.now() + cooldownMs);
          }
        } else if (res.status >= 500 && selectedProvider === 'github') {
          const proxyStr2 = keyProxyMap.get(selectedKey);
          if (proxyStr2) {
            const ph = proxyHealth.get(proxyStr2) || { failures: 0 };
            ph.failures++;
            proxyHealth.set(proxyStr2, ph);
            if (ph.failures > 50) deadProxies.add(proxyStr2);
          }
        }

        continue;
      }

      keyDailyUsage.set(selectedBucket, (keyDailyUsage.get(selectedBucket) || 0) + 1);
      
      // Strip <think>...</think> reasoning blocks (reasoning models like qwen3)
      let content = (data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || "");
      if (content.includes('<think>')) {
        // If properly closed, strip the block
        content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        // If still starts with <think> (unclosed — model was cut off mid-reasoning), discard
        if (content.startsWith('<think>') || content.trim() === '') {
          lastError = new Error('Model returned unclosed <think> block — output discarded.');
          totalFailures++;
          continue;
        }
      }
      const finishReason = data?.choices?.[0]?.finish_reason || 'unknown';
      const usage = data.usage || {};
      console.log(`[REQ #${totalRequests}][${selectedProvider}] ✅ model=${selectedModel} | finish=${finishReason} | in=${usage.prompt_tokens || '?'} out=${usage.completion_tokens || '?'} | chars=${content.length}`);
      if (!content.trim()) {
        lastError = new Error("Models returned empty content.");
        totalFailures++;
        continue;
      }
      return { content: content.trim(), model: selectedModel, usage, finishReason };
    } catch (err) {
      lastError = err;
      totalFailures++;
      if (proxyStr && (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.name === 'TimeoutError')) {
        const ph = proxyHealth.get(proxyStr) || { failures: 0 };
        ph.failures++;
        proxyHealth.set(proxyStr, ph);
        if (ph.failures > 50) deadProxies.add(proxyStr);
      }
    } finally {
      inFlightBucket.set(selectedBucket, Math.max(0, inFlightBucket.get(selectedBucket) - 1));
    }
  }

  throw lastError || new Error("GitHub Models call failed after " + attempts + " attempts.");
}

async function summarizeChunk(keys, models, cacheDir, topicName, chunk, source, sourceIndex, sourceCount) {
  const summaryFile = path.join(cacheDir, "chunk_summaries", `${chunk.chunk_id}.json`);
  if (fs.existsSync(summaryFile)) {
    const cached = JSON.parse(readText(summaryFile));
    if (
      cached.summary &&
      cached.char_start === chunk.char_start &&
      cached.char_end === chunk.char_end &&
      cached.char_count === chunk.char_count
    ) {
      return cached;
    }
  }

  const result = await callGitHub(
    keys,
    models,
    [
      {
        role: "system",
        content:
          "You preserve transcript evidence for later whole-book synthesis. Output dense Markdown notes only. Do not add unsupported facts.",
      },
      {
        role: "user",
        content: `Topic: ${topicName}
Source ${sourceIndex + 1}/${sourceCount}: ${source.title}
File: ${source.filename}
Chunk: ${chunk.chunk_index}

Extract compact but complete evidence notes from this transcript chunk.

Include:
- concepts taught
- process steps
- examples
- definitions
- formulas, metrics, tools, or code concepts
- relationships between ideas
- any distinctive project/story framing

Transcript chunk:
<transcript>
${chunk.text}
</transcript>`,
      },
    ],
    { maxTokens: 1400, temperature: 0.1 },
  );
  const summary = {
    ...chunk,
    summary: result.content,
    model: result.model,
    usage: result.usage,
  };
  writeJson(summaryFile, summary);
  return summary;
}

async function synthesizeSource(keys, models, cacheDir, pkg, source, chunkSummaries) {
  const sourceFile = path.join(cacheDir, `${safeSegment(source.source_id)}_source_synthesis.md`);
  if (fs.existsSync(sourceFile) && fs.statSync(sourceFile).size > 500) {
    return {
      source_id: source.source_id,
      filename: source.filename,
      title: pkg.sources.find((s) => s.source_id === source.source_id)?.title || source.title,
      synthesis: readText(sourceFile),
      model: "cached",
    };
  }

  const sourceMeta = pkg.sources.find((s) => s.source_id === source.source_id);
  const evidenceItems = chunkSummaries.map((chunk) => ({ id: chunk.chunk_id, text: chunk.summary }));
  let reducedEvidence = evidenceItems;
  const rawEvidenceChars = evidenceItems.reduce((sum, item) => sum + item.text.length, 0);
  if (rawEvidenceChars > 14000) {
    const batchDir = path.join(cacheDir, "source_reduce");
    ensureDir(batchDir);
    const batches = packTextItems(
      evidenceItems,
      9000,
      (item) => `\n--- ${item.id} ---\n${item.text.slice(0, 1600)}`,
    );

    reducedEvidence = [];
    for (let i = 0; i < batches.length; i++) {
      const reducePath = path.join(
        batchDir,
        `${safeSegment(source.source_id)}_reduce_${String(i).padStart(3, "0")}.md`,
      );
      if (fs.existsSync(reducePath) && fs.statSync(reducePath).size > 300) {
        reducedEvidence.push({ id: `reduce_${i}`, text: readText(reducePath) });
        continue;
      }

      const result = await callGitHub(
        keys,
        models,
        [
          {
            role: "system",
            content:
              "Compress transcript evidence notes without losing concepts, examples, sequence, or relationships. Markdown only.",
          },
          {
            role: "user",
            content: `Topic: ${pkg.topic}
Source: ${sourceMeta.title}
Batch: ${i + 1}/${batches.length}

Condense these chunk notes into a compact evidence brief.
Preserve concepts, sequence, examples, formulas/metrics/tools, relationships, and project/story framing.

Chunk notes:
${batches[i]
  .map((item) => `\n--- ${item.id} ---\n${item.text.slice(0, 1600)}`)
  .join("\n")}`,
          },
        ],
        { maxTokens: 1200, temperature: 0.1 },
      );
      fs.writeFileSync(reducePath, result.content, "utf8");
      reducedEvidence.push({ id: `reduce_${i}`, text: result.content });
    }
  }

  const result = await callGitHub(
    keys,
    models,
    [
      {
        role: "system",
        content:
          "You synthesize course transcript notes into a faithful source-level brief. Preserve teaching order, examples, and important relationships. Markdown only.",
      },
      {
        role: "user",
        content: `Topic: ${pkg.topic}
Source: ${sourceMeta.title}
File: ${sourceMeta.filename}

Metadata:
${JSON.stringify(sourceMeta.metadata || {}, null, 2).slice(0, 4000)}

Chunk evidence notes:
${reducedEvidence
  .map((chunk) => `\n--- ${chunk.id} ---\n${chunk.text.slice(0, 900)}`)
  .join("\n")}

Create a source-level synthesis for this course/file.

Must include:
- what this source contributes to the topic
- major concepts in teaching order
- examples and projects
- relationships to other likely sources
- thin/unclear areas if any`,
      },
    ],
    { maxTokens: 1800, temperature: 0.15 },
  );

  const synthesis = {
    source_id: source.source_id,
    filename: source.filename,
    title: sourceMeta.title,
    synthesis: result.content,
    model: result.model,
  };
  fs.writeFileSync(sourceFile, synthesis.synthesis, "utf8");
  return synthesis;
}

function renderRawSnippets(rawSnippets) {
  if (!rawSnippets.length) return "No raw transcript snippets selected.";
  return rawSnippets
    .map(
      (snippet, index) => `===== RAW EVIDENCE ${index + 1}: ${snippet.source_id} / chunk ${snippet.chunk_index} =====
File: ${snippet.filename}
Matched terms: ${snippet.matched_terms.join(", ")}
${snippet.snippet}`,
    )
    .join("\n\n");
}

function renderRawSnippetsLimited(rawSnippets, limit = 5) {
  return renderRawSnippets(rawSnippets.slice(0, limit));
}

function baselineFileFor(topicName, type, baselineDir) {
  if (!baselineDir || !fs.existsSync(baselineDir)) return null;
  const suffix = `_${type}.md`;
  const wanted = safeSegment(topicName).toLowerCase();
  const files = fs
    .readdirSync(baselineDir)
    .filter((file) => file.toLowerCase().includes(wanted) && file.endsWith(suffix))
    .sort();
  return files[0] ? path.join(baselineDir, files[0]) : null;
}

function baselineCalibrationSample(baseline) {
  if (!baseline) return "";
  const normalized = baseline.replace(/\r\n/g, "\n");
  const opening = normalized.slice(0, 8500).trim();
  const outlineLines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        line.length <= 100 &&
        (/^PART\s+\d+/i.test(line) ||
          /^\d+\./.test(line) ||
          line.includes("->") ||
          /^[A-Z][A-Z0-9 &/+()'-]{8,}$/.test(line)),
    )
    .slice(0, 90)
    .join("\n");
  return `${opening}\n\nBenchmark outline cues:\n${outlineLines}`.slice(0, 9200);
}

function baselineOutlineCues(baseline) {
  if (!baseline) return "";
  return baseline
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      if (line.length > 110) return false;
      return (
        /^PART\s+\d+/i.test(line) ||
        /^[A-Z][A-Z0-9 &/+()'.-]{8,}$/.test(line) ||
        /^\d+[\.)]\s+/.test(line) ||
        line.includes("\u2014") ||
        line.includes("->") ||
        line.includes("\u2192")
      );
    })
    .slice(0, 120)
    .join("\n");
}

function isIntakeBenchmark(baseline) {
  return /upload one of these/i.test(baseline || "") ||
    /need the .*?(book|transcript|file)/i.test(baseline || "");
}

function benchmarkModeInstruction(type, baseline) {
  if (!isIntakeBenchmark(baseline)) return "";
  return [
    "The ChatGPT UI benchmark is an intake/request-for-source-material response, not a completed synthesis.",
    "Match that response mode: ask for the source material and outline exactly how the topic will be explained.",
    "Do not expand into a full completed course/book explanation even if transcript evidence is available.",
    "Preserve the benchmark's standalone planning labels, short lines, examples, and final master-map promise.",
    type === "knowledge_map"
      ? "Include labels such as Big Picture, Concept Mapping, Every Symbol, Mental Model, Process Simulation, Relationship Mapping, Common Mistakes, Interview Perspective, Real-Life Analogies, Memory Maps, Advanced Topics, and End-of-Book Master Map when the benchmark contains that plan."
      : "Keep the response as a setup/plan if the benchmark is a setup/plan.",
  ].join("\n- ");
}

function buildIntakeBenchmarkPrompt(topicName, type, baseline) {
  return [
    {
      role: "system",
      content:
        "You reproduce the user's ChatGPT UI response mode for a production prompt benchmark. Output Markdown/plain text only. Do not use code fences.",
    },
    {
      role: "user",
      content: `Topic: ${topicName}
Prompt type: ${type}

The ChatGPT UI benchmark below is the target response mode. It is an intake/request-for-source-material response and teaching plan, not a completed synthesis.

Write a close API equivalent for the same topic.

Rules:
- Keep the same structure, depth, organization, response length, and short-line style.
- Preserve the same standalone labels and example-style sections.
- Keep the answer around ${Math.round(baseline.length * 0.9)}-${Math.round(baseline.length * 1.15)} characters.
- Do not expand into the completed course/book explanation.
- Do not use Markdown # headings or code fences.
- Use many short lines like the benchmark.
- Finish with a complete closing sentence. Do not stop mid-list, mid-formula, or mid-thought.

ChatGPT UI benchmark:
<benchmark>
${baseline}
</benchmark>

Return only the benchmark-equivalent output.`,
    },
  ];
}

function benchmarkCalibrationFor(type, baseline) {
  const lines = [
    "Use the current ChatGPT UI benchmark style: direct teaching voice, short lines, simple arrows, concrete examples, and clear sections.",
    "The output should feel like one understandable learning journey, not a generic encyclopedia article.",
    "It may include simple illustrative examples when they are clearly aligned with transcript evidence.",
  ];
  if (baseline) {
    lines.push(
      "A ChatGPT UI benchmark sample is provided below. Use it as the primary target for structure, depth, coverage, organization, and response length. Do not copy it verbatim.",
    );
  }
  if (type === "knowledge_map") {
    lines.push("Prefer relationship maps, dependency arrows, hierarchy, and flow over standalone essays.");
  }
  return lines.join("\n- ");
}

function buildFinalPrompt(pkg, type, sourceSyntheses, targetLength, rawSnippets, baseline) {
  if (isIntakeBenchmark(baseline)) {
    return buildIntakeBenchmarkPrompt(pkg.topic, type, baseline);
  }
  const profile = profileFor(type);
  const manySources = sourceSyntheses.length > 4;
  const baselineSample = baseline
    ? baselineCalibrationSample(baseline).slice(0, manySources ? 4200 : 9200)
    : "";
  const outlineCues = baselineOutlineCues(baseline).slice(0, manySources ? 2200 : 5000);
  const phraseCues = baselinePhraseCues(baseline, 70);
  const benchmarkMode = benchmarkModeInstruction(type, baseline);
  const manifestLimit = manySources ? 2600 : 5000;
  const rawSnippetLimit = manySources ? 4 : 5;
  const sourceSynthesisLimit = manySources ? 650 : 1200;
  const baselineLines = baseline ? baseline.split("\n").length : 0;
  return [
    {
      role: "system",
      content:
        "You are an expert AI assistant helping explain course material. Output only the requested material in Markdown. Do not use conversational filler. Do not wrap the answer in code fences. Keep transcript facts grounded in the supplied evidence; simple teaching examples may be illustrative when clearly aligned with the evidence.",
    },
    {
      role: "user",
      content: `Production prompt type: ${profile.name}
Topic: ${pkg.topic}

Goal:
${profile.instruction}

Expected organization:
${profile.structure}

Required response style:
${profile.style}

Required coverage:
${profile.mustCover}

Benchmark calibration:
- ${benchmarkCalibrationFor(type, baseline)}
- ${benchmarkMode || "The benchmark is a completed output; produce a completed output in the same style."}

Target quality:
- Match the user's current ChatGPT UI output quality for this prompt type.
- Write a comprehensive long-form synthesis when evidence warrants it.
- Target roughly ${Math.round(targetLength * 0.9)}-${Math.round(targetLength * 1.18)} characters.
- Match the ChatGPT UI line density: use many short teaching lines, not dense paragraphs.${baselineLines ? ` The benchmark has about ${baselineLines} lines.` : ""}
- Use one idea per line. Prefer short line breaks over paragraph blocks.
- Do not use Markdown # headings. Use plain standalone section labels such as PART 1, The Core Idea, Example, Result, Final Map.
- Do not use Markdown code fences, even for maps. Use plain text maps directly.
- Preserve complete coverage across all source files.
- Preserve teaching order, examples, mappings, and relationships.
- Avoid generic textbook filler when transcript-specific evidence is available.
- If evidence spans multiple courses, make each course's contribution visible.
- Do not use Mermaid diagrams or Markdown code fences. Use plain text maps, lists, and sections.
- For knowledge_map, preserve PART-style map sections, major benchmark map labels, and plain text relationship arrows where supported by the evidence.
- Finish the response cleanly; do not leave any section truncated.

Source manifest:
${manifestMarkdown(pkg).slice(0, manifestLimit)}

High-priority raw transcript evidence snippets:
${renderRawSnippetsLimited(rawSnippets, rawSnippetLimit)}

${baselineSample ? `ChatGPT UI benchmark sample:\n<benchmark_sample>\n${baselineSample}\n</benchmark_sample>\n` : ""}
${outlineCues ? `Required benchmark outline cues:\nPreserve these major labels and relationship-flow cues where relevant. Use plain labels, not Markdown # headings.\n<benchmark_outline>\n${outlineCues}\n</benchmark_outline>\n` : ""}
${phraseCues ? `High-value benchmark phrase cues:\nPreserve these benchmark concepts where supported by transcript evidence:\n${phraseCues}\n` : ""}
Source-level evidence syntheses:
${sourceSyntheses
  .map((source) => `\n===== ${source.source_id}: ${source.title} (${source.filename}) =====\n${source.synthesis.slice(0, sourceSynthesisLimit)}`)
  .join("\n")}

Now produce the final ${profile.name} output for ${pkg.topic}.

Start directly with the explanation. Do not begin with a Markdown H1 title.`,
    },
  ];
}

function countPattern(text, pattern) {
  return (text.match(pattern) || []).length;
}

function deterministicMetrics(text, baselineLength = 0) {
  return {
    chars: text.length,
    baseline_chars: baselineLength || null,
    length_ratio: baselineLength ? Number((text.length / baselineLength).toFixed(2)) : null,
    lines: text.split(/\n/).length,
    examples: countPattern(text, /\bexample\b/gi),
    parts: countPattern(text, /\bpart\s+\d+\b/gi),
    numbered_sections: countPattern(text, /^\s*\d+[\.)]\s+/gm),
  };
}

async function auditOutput(keys, models, pkg, type, output, baseline, sourceSyntheses) {
  const withBaseline = Boolean(baseline);
  const result = await callGitHub(
    keys,
    models,
    [
      {
        role: "system",
        content:
          "You are a strict evaluator for long-form transcript synthesis. Return valid JSON only. Do not use Markdown fences.",
      },
      {
        role: "user",
        content: withBaseline
          ? `Evaluate whether the API output matches the ChatGPT UI baseline quality for the same production prompt.

Prompt type: ${type}
Topic: ${pkg.topic}

Primary criterion:
The ChatGPT UI baseline is the quality target. Judge whether the API output is close enough that a user would see no meaningful degradation in structure, depth, coverage, reasoning, completeness, organization, response length, and teaching style.

Secondary criterion:
Use the source syntheses only to catch unsupported claims or serious omissions. Do not fail the API output merely because it omits source details that the ChatGPT UI baseline also does not emphasize.

Source manifest:
${manifestMarkdown(pkg).slice(0, 2500)}

Source syntheses:
${sourceSyntheses
  .map((source) => `\n--- ${source.source_id}: ${source.title} ---\n${source.synthesis.slice(0, 500)}`)
  .join("\n")}

ChatGPT UI baseline:
<baseline>
${baseline.slice(0, 8500)}
</baseline>

API output:
<api_output>
${output.slice(0, 10000)}
</api_output>

Return strict JSON with:
{
  "matches": true/false,
  "quality_score": 0.0-1.0,
  "coverage_score": 0.0-1.0,
  "structure_score": 0.0-1.0,
  "depth_score": 0.0-1.0,
  "source_coverage": [{"source_id":"...","covered":true/false,"reason":"..."}],
  "missing_items": ["..."],
  "required_patch": "short instruction or empty string"
}

Return only the JSON object.`
          : `Evaluate this long-form transcript synthesis against the source package.

Prompt type: ${type}
Topic: ${pkg.topic}

Source manifest:
${manifestMarkdown(pkg).slice(0, 2500)}

Source syntheses:
${sourceSyntheses
  .map((source) => `\n--- ${source.source_id}: ${source.title} ---\n${source.synthesis.slice(0, 650)}`)
  .join("\n")}

Output:
<api_output>
${output.slice(0, 10000)}
</api_output>

Return strict JSON with:
{
  "matches": true/false,
  "quality_score": 0.0-1.0,
  "coverage_score": 0.0-1.0,
  "structure_score": 0.0-1.0,
  "depth_score": 0.0-1.0,
  "source_coverage": [{"source_id":"...","covered":true/false,"reason":"..."}],
  "missing_items": ["..."],
  "required_patch": "short instruction or empty string"
}

Return only the JSON object.`,
      },
    ],
    { maxTokens: 1000, temperature: 0 },
  );

  const jsonText = extractJson(result.content);
  try {
    return JSON.parse(jsonText);
  } catch {
    const normalized = jsonText
      .replace(/"covered"\s*:\s*partial\b/gi, '"covered": false')
      .replace(/"covered"\s*:\s*covered\b/gi, '"covered": true')
      .replace(/"covered"\s*:\s*missing\b/gi, '"covered": false');
    try {
      return JSON.parse(normalized);
    } catch {
      return {
        matches: false,
        quality_score: 0,
        coverage_score: 0,
        structure_score: 0,
        depth_score: 0,
        source_coverage: [],
        missing_items: ["Evaluator returned invalid JSON."],
        required_patch: "Re-run evaluator or inspect manually.",
        raw: result.content,
      };
    }
  }
}

async function patchOutput(keys, models, pkg, type, output, audit, sourceSyntheses, rawSnippets, baseline, targetLength) {
  if (!audit.required_patch && (!audit.missing_items || audit.missing_items.length === 0)) {
    return output;
  }
  const profile = profileFor(type);
  const outlineCues = baselineOutlineCues(baseline).slice(0, 2500);
  const phraseCues = baselinePhraseCues(baseline, 70);
  const benchmarkMode = benchmarkModeInstruction(type, baseline);
  const baselineLines = baseline ? baseline.split("\n").length : 0;
  const targetMinLines = Math.round(baselineLines * 0.55);
  const maxTokens = isIntakeBenchmark(baseline)
    ? Math.max(900, Math.min(1400, Math.ceil((targetLength * 0.9) / 4) + 220))
    : Math.max(1800, Math.min(4600, Math.ceil((targetLength * 1.18) / 4) + 500));
  const result = await callGitHub(
    keys,
    models,
    [
      {
        role: "system",
        content:
          "You patch long-form course synthesis using supplied evidence and the benchmark target. Return the full improved Markdown output, not notes about changes. Do not wrap the answer in code fences.",
      },
      {
        role: "user",
        content: `Patch this ${type} output for ${pkg.topic}.

Problems found:
${JSON.stringify(audit, null, 2).slice(0, 1800)}

Source manifest:
${manifestMarkdown(pkg).slice(0, 1800)}

Required coverage:
${profile.mustCover}

Benchmark calibration:
- ${benchmarkCalibrationFor(type, baseline)}
- ${benchmarkMode || "The benchmark is a completed output; preserve that completed-output response mode."}
- Match the benchmark's short-line teaching shape. Target at least ${targetMinLines} lines when possible.
- Use one idea per line. Break dense paragraphs into short standalone teaching lines.
- If line-density or example-count issues are listed, use sparse outline formatting: short labels, short example blocks, and one fact per line.
- If the current output ends abruptly, preserve the existing useful content but complete the final section with a short closing summary.
- Always finish with a complete final sentence. Do not stop after a dangling label, formula, arrow, or partial clause.

High-priority raw transcript evidence snippets:
${renderRawSnippetsLimited(rawSnippets, 5)}

${baseline ? `ChatGPT UI benchmark sample:\nUse this only as a style, organization, coverage-depth, and response-shape target. Do not copy it verbatim.\n<benchmark_sample>\n${baselineCalibrationSample(baseline).slice(0, 3000)}\n</benchmark_sample>\n` : ""}
${outlineCues ? `Required benchmark outline cues:\nPreserve these major labels and relationship-flow cues where relevant. Use plain labels, not Markdown # headings.\n<benchmark_outline>\n${outlineCues}\n</benchmark_outline>\n` : ""}
${phraseCues ? `High-value benchmark phrase cues:\nPreserve these benchmark concepts where supported by transcript evidence:\n${phraseCues}\n` : ""}
Source evidence syntheses:
${sourceSyntheses
  .map((source) => `\n===== ${source.source_id}: ${source.title} =====\n${source.synthesis.slice(0, 450)}`)
  .join("\n")}

Current output:
<current>
${output.slice(0, 5500)}
</current>

Return the full improved output. Target about ${Math.round(targetLength * 0.95)}-${Math.round(
          targetLength * 1.15,
        )} characters if evidence supports it. Preserve complete coverage across all sources. Add concrete transcript-specific and clearly illustrative examples instead of generic filler. Match the ChatGPT UI line-by-line teaching shape. For knowledge_map, preserve PART-style map sections and relationship arrows where supported. Do not use Markdown # headings or code fences. Finish cleanly with no truncated section.`,
      },
    ],
    { maxTokens, temperature: 0.15, timeoutMs: 240000 },
  );
  return normalizeGeneratedOutput(result.content);
}

async function expandShortOutput(keys, models, pkg, type, output, audit, rawSnippets, baseline, targetLength) {
  const profile = profileFor(type);
  const outlineCues = baselineOutlineCues(baseline).slice(0, 2500);
  const phraseCues = baselinePhraseCues(baseline, 70);
  const benchmarkMode = benchmarkModeInstruction(type, baseline);
  const baselineLines = baseline ? baseline.split("\n").length : 0;
  const targetMinLines = Math.round(baselineLines * 0.55);
  const tooLong = output.length > targetLength * 1.35;
  const targetMinChars = tooLong
    ? Math.round(targetLength * 0.85)
    : Math.round(targetLength * 0.9);
  const targetMaxChars = tooLong
    ? Math.round(targetLength * 1.15)
    : Math.round(targetLength * 1.25);
  const shortKnowledgeMap = type === "knowledge_map" && targetLength < 7000;
  const maxTokens = tooLong
    ? Math.max(800, Math.min(1250, Math.ceil((targetLength * 0.72) / 4) + 120))
    : shortKnowledgeMap
      ? Math.max(1100, Math.min(1700, Math.ceil((targetLength * 0.95) / 4) + 260))
      : Math.max(1800, Math.min(4600, Math.ceil((targetLength * 1.2) / 4) + 550));
  const result = await callGitHub(
    keys,
    models,
    [
      {
        role: "system",
        content:
          "You align an already good course synthesis to match the required benchmark depth and shape. Return the full aligned Markdown output only. Do not wrap the answer in code fences.",
      },
      {
        role: "user",
        content: `The current ${type} output for ${pkg.topic} needs alignment with the target.

Hard requirement:
- Return roughly ${targetMinChars}-${targetMaxChars} characters.
- The validator fails if the answer exceeds ${targetMaxChars} characters, so remove optional detail before crossing that limit.
- If the current output is too short, expand with missing concrete sections and examples.
- If the current output is too long, condense aggressively: keep the benchmark's main labels and source-backed relationships, but remove repeated explanations, extra advanced branches, and low-priority detail.
- Keep the same direct teaching style.
- Match the ChatGPT UI line density with many short lines and standalone labels. Target at least ${targetMinLines} lines when possible.
- Use one idea per line. Break dense paragraphs into short standalone teaching lines.
- For short knowledge-map benchmarks, prefer many short lines over paragraphs; most lines should be under 45 characters.
- If line-density or example-count issues are listed, use sparse outline formatting: short labels, short example blocks, and one fact per line.
- For knowledge_map, restore PART-style map sections, major benchmark map labels, and relationship arrows where supported. Keep each branch compact.
- Do not use Markdown # headings, tables, or code fences.
- Do not add new topics beyond the benchmark cues and transcript evidence just to increase completeness.
- If the current output ends abruptly, complete the final section and add a brief closing summary.
- Always finish with a complete final sentence. Do not stop after a dangling label, formula, arrow, or partial clause.

Required coverage:
${profile.mustCover}

Benchmark calibration:
- ${benchmarkCalibrationFor(type, baseline)}
- ${benchmarkMode || "The benchmark is a completed output; preserve that completed-output response mode."}

Specific expansion focus:
${JSON.stringify(audit.missing_items || [], null, 2)}

High-priority raw transcript evidence snippets:
${renderRawSnippetsLimited(rawSnippets, 4)}

${baseline ? `ChatGPT UI benchmark sample:\nUse this only as style and coverage-depth calibration. Do not copy it verbatim.\n<benchmark_sample>\n${baselineCalibrationSample(baseline).slice(0, 3000)}\n</benchmark_sample>\n` : ""}
${outlineCues ? `Required benchmark outline cues:\nPreserve these major labels and relationship-flow cues where relevant. Use plain labels, not Markdown # headings.\n<benchmark_outline>\n${outlineCues}\n</benchmark_outline>\n` : ""}
${phraseCues ? `High-value benchmark phrase cues:\nPreserve these benchmark concepts where supported by transcript evidence:\n${phraseCues}\n` : ""}
Current output:
<current>
${output.slice(0, tooLong ? 5200 : 7000)}
</current>

Return the full ${tooLong ? "condensed" : "expanded"} output now.`,
      },
    ],
    { maxTokens, temperature: 0.12, timeoutMs: 240000 },
  );
  return normalizeGeneratedOutput(result.content);
}

async function generateGithubPhase1Synthesis(options) {
  const {
    topicName,
    transcriptsDir,
    files,
    metadataDir,
    responsePartsDir,
    promptType,
    githubKeys,
    githubModels,
    baselineDir = path.join(process.cwd(), "scratch", "chatgpt-runner-out"),
    log = () => {},
  } = options || {};

  if (!PROMPT_TYPES.has(promptType)) {
    throw new Error(`Unsupported GitHub Phase 1 prompt type: ${promptType}`);
  }
  if (!topicName || !transcriptsDir || !Array.isArray(files) || !responsePartsDir) {
    throw new Error("Missing required GitHub Phase 1 synthesis options.");
  }

  const models = normalizeModels(githubModels);
  const cacheDir = path.join(responsePartsDir, ".github_phase1_cache");
  ensureDir(cacheDir);
  ensureDir(path.join(cacheDir, "chunk_summaries"));

  log(`GitHub staged synthesis for ${topicName} (${promptType})`);
  log(`Models: ${models.join(", ")}`);

  const sources = discoverTranscriptFiles(transcriptsDir, files);
  if (!sources.length) throw new Error("No transcript files found for GitHub Phase 1 synthesis.");

  const pkg = buildSourcePackage(topicName, path.dirname(transcriptsDir), sources, metadataDir);
  writeJson(path.join(cacheDir, "source_package.json"), pkg);
  log(`Discovered ${sources.length} transcript files (${pkg.total_chars} chars)`);

  const allChunkSummaries = [];
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    const source = sources[sourceIndex];
    const chunks = splitIntoChunks(source);
    log(`Source ${sourceIndex + 1}/${sources.length}: ${source.filename} -> ${chunks.length} chunks`);
    const summaries = await mapLimit(chunks, SUMMARY_CONCURRENCY, async (chunk, chunkIndex) => {
      log(`Summarizing ${source.filename} chunk ${chunkIndex + 1}/${chunks.length}`);
      return summarizeChunk(
        githubKeys,
        models,
        cacheDir,
        topicName,
        chunk,
        source,
        sourceIndex,
        sources.length,
      );
    });
    allChunkSummaries.push(...summaries);
  }

  const sourceSyntheses = [];
  for (const source of sources) {
    log(`Building source synthesis: ${source.filename}`);
    const summaries = allChunkSummaries.filter((chunk) => chunk.source_id === source.source_id);
    sourceSyntheses.push(await synthesizeSource(githubKeys, models, cacheDir, pkg, source, summaries));
  }
  writeJson(path.join(cacheDir, "source_syntheses.json"), sourceSyntheses);

  const rawSnippets = selectRawEvidenceSnippets(sources, topicName, promptType);
  writeJson(path.join(cacheDir, `${promptType}_raw_evidence_snippets.json`), rawSnippets);

  const baselinePath = baselineFileFor(topicName, promptType, baselineDir);
  const baseline = baselinePath ? readText(baselinePath) : "";
  const profile = profileFor(promptType);
  const targetLength = baseline.length || profile.targetLength;
  const intakeBenchmark = isIntakeBenchmark(baseline);
  log(
    baselinePath
      ? `Using ChatGPT UI benchmark for ${promptType} (${baseline.length} chars)`
      : `No ChatGPT UI benchmark found for ${promptType}; using generic target (${targetLength} chars)`,
  );

  const finalPrompt = buildFinalPrompt(pkg, promptType, sourceSyntheses, targetLength, rawSnippets, baseline);
  const finalMaxTokens = isIntakeBenchmark(baseline)
    ? Math.max(900, Math.min(1400, Math.ceil((targetLength * 0.9) / 4) + 220))
    : Math.max(1800, Math.min(5200, Math.ceil((targetLength * 1.25) / 4) + 550));
  const draft = await callGitHub(githubKeys, models, finalPrompt, {
    maxTokens: finalMaxTokens,
    temperature: 0.18,
    timeoutMs: 240000,
  });
  const draftText = normalizeGeneratedOutput(draft.content);
  const draftPath = path.join(cacheDir, `${safeSegment(topicName)}_${promptType}_draft.md`);
  fs.writeFileSync(draftPath, draftText, "utf8");

  log(`Auditing ${promptType}; draft=${draftText.length} chars`);
  const draftAudit = await auditOutput(
    githubKeys,
    models,
    pkg,
    promptType,
    draftText,
    baseline,
    sourceSyntheses,
  );
  const draftMetrics = deterministicMetrics(draftText, baseline.length);
  const draftLocalIssues = localParityIssues(promptType, draftText, baseline);
  let finalText = draftText;
  let finalAudit = draftAudit;

  const needsPatch =
    draftLocalIssues.length > 0 ||
    (!intakeBenchmark && !draftAudit.matches) ||
    (!intakeBenchmark && Number(draftAudit.quality_score || 0) < 0.86) ||
    (!intakeBenchmark && Number(draftAudit.coverage_score || 0) < 0.9) ||
    (baseline.length && (draftMetrics.length_ratio < 0.8 || draftMetrics.length_ratio > 1.4));
  if (needsPatch) {
    log(`Patching ${promptType} due to audit gaps`);
    const patchAudit = {
      ...draftAudit,
      missing_items: [
        ...(draftAudit.missing_items || []),
        ...draftLocalIssues,
      ],
      required_patch: [
        draftAudit.required_patch || "",
        ...draftLocalIssues,
      ]
        .filter(Boolean)
        .join("\n"),
    };
    finalText = await patchOutput(
      githubKeys,
      models,
      pkg,
      promptType,
      draftText,
      patchAudit,
      sourceSyntheses,
      rawSnippets,
      baseline,
      targetLength,
    );
    finalAudit = await auditOutput(
      githubKeys,
      models,
      pkg,
      promptType,
      finalText,
      baseline,
      sourceSyntheses,
    );
  }

  let finalMetrics = deterministicMetrics(finalText, baseline.length);
  let finalLocalIssues = localParityIssues(promptType, finalText, baseline);
  const tooShort = baseline.length ? finalMetrics.length_ratio < 0.8 : finalText.length < targetLength * 0.82;
  const tooLong = baseline.length ? finalMetrics.length_ratio > 1.35 : false;
  if (tooShort || tooLong || finalLocalIssues.length > 0) {
    log(
      `Expanding/alignment pass for ${promptType}; current chars=${finalText.length}, target=${targetLength}, deterministic_issues=${finalLocalIssues.length}`,
    );
    finalText = await expandShortOutput(
      githubKeys,
      models,
      pkg,
      promptType,
      finalText,
      {
        ...finalAudit,
        missing_items: [...(finalAudit.missing_items || []), ...finalLocalIssues],
        required_patch: [
          finalAudit.required_patch || "",
          ...finalLocalIssues,
        ]
          .filter(Boolean)
          .join("\n"),
      },
      rawSnippets,
      baseline,
      targetLength,
    );
    finalAudit = await auditOutput(
      githubKeys,
      models,
      pkg,
      promptType,
      finalText,
      baseline,
      sourceSyntheses,
    );
    finalMetrics = deterministicMetrics(finalText, baseline.length);
    finalLocalIssues = localParityIssues(promptType, finalText, baseline);
  }

  const finalPath = path.join(cacheDir, `${safeSegment(topicName)}_${promptType}_github_phase1.md`);
  fs.writeFileSync(finalPath, finalText, "utf8");
  writeJson(path.join(cacheDir, `${promptType}_audit.json`), {
    topic: topicName,
    prompt_type: promptType,
    generated_at: new Date().toISOString(),
    benchmark_path: baselinePath,
    draft_path: draftPath,
    output_path: finalPath,
    draft_chars: draftText.length,
    final_chars: finalText.length,
    metrics: finalMetrics,
    audit: finalAudit,
    patched: needsPatch,
    deterministic_issues: finalLocalIssues,
    total_requests: totalRequests,
    total_call_failures: totalFailures,
  });
  log(`${promptType}: chars=${finalText.length}, requests=${totalRequests}, failures=${totalFailures}`);
  return finalText;
}

module.exports = {
  generateGithubPhase1Synthesis,
  normalizeGeneratedOutput,
  getGithubPhase1Stats: () => ({
    total_requests: totalRequests,
    total_call_failures: totalFailures,
  }),
};
