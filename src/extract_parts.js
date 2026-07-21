import crypto from 'crypto';

function extractParts(text) {
  text = text.replace(/\r/g, "");

  text = text
    .replace(/ChatGPT can make mistakes[\s\S]*/gi, "")
    .replace(/Ask anything/gi, "")
    .trim();

  // PRIMARY STRUCTURAL SPLIT
  // Only split on well-defined structural markers:
  //   PART/SECTION/CHAPTER/TOPIC N, numbered items (22. Tableau), markdown headings,
  //   and known patterns like "CORE PILLAR N" and "STEP N".
  // ALL-CAPS detection is intentionally NOT done here — the old regex [A-Z][A-Z\s...]{3,}
  // was producing 300+ micro-fragments (splitting on "SQL", "EXAMPLE", "CORE IDEA", etc.).
  // The AI partitioner handles ALL-CAPS heading detection correctly.
  let blocks = text.split(
    /\n(?=(?:PART\s+\d+|SECTION\s+\d+|CHAPTER\s+\d+|TOPIC\s+\d+|\d+\.\s+\S|#{1,6}\s|CORE\s+PILLAR\s*\d*|STEP\s+\d+|===\s+.+?\s+===))/gi,
  );

  // FALLBACK IF NO HEADINGS DETECTED
  if (blocks.length <= 2) {
    blocks = text.split(/\n\s*\n/g);
  }

  const finalParts = [];

  // MIN_CHUNK only applies to minor boundaries (numbered headings, ALL CAPS).
  // Major structural boundaries (PART, SECTION, CHAPTER) always flush.
  const MIN_CHUNK = 800;
  const MAX_CHUNK = 9000;

  let current = "";

  // Detect whether a block starts with a numbered list item (e.g. "22. Tableau...")
  const NUMBERED_HEADING = /^(\d+\.\s+\S)/;

  // Major structural boundaries that should ALWAYS cause a flush
  const MAJOR_BOUNDARY = /(?:^|\n)(?:PART\s+\d+|SECTION\s+\d+|CHAPTER\s+\d+|TOPIC\s+\d+|CORE\s+PILLAR\s*\d*|STEP\s+\d+)/i;

  for (let block of blocks) {
    block = block.trim();

    if (!block) continue;

    const isMajorBoundary = MAJOR_BOUNDARY.test(block);
    const isMinorBoundary =
      /(?:^|\n)(?:#{1,6} )/i.test(block) ||
      NUMBERED_HEADING.test(block);

    // Major boundaries (PART/SECTION/CHAPTER) → ALWAYS flush, no minimum size check
    if (isMajorBoundary && current.trim()) {
      finalParts.push(current.trim());
      current = block;
    }
    // Minor boundaries → only flush if buffer is large enough
    else if (isMinorBoundary && current.trim().length >= MIN_CHUNK) {
      finalParts.push(current.trim());
      current = block;
    } else {
      current += (current ? "\n\n" : "") + block;
    }

    if (current.length >= MAX_CHUNK) {
      finalParts.push(current.trim());
      current = "";
    }
  }

  if (current.trim()) {
    finalParts.push(current.trim());
  }

  // ORDER-PRESERVING DEDUPE
  const seen = new Set();

  return finalParts.filter((part) => {
    const key = crypto
      .createHash("sha1")
      .update(part)
      .digest("hex");

    if (seen.has(key)) return false;

    seen.add(key);

    return true;
  });
}

export { extractParts };