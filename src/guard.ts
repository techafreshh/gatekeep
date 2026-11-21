// Guard: strip hidden/unsafe content from untrusted ingest and query text.
//
// Pure, dependency-free. Dirty input is cleaned, never rejected; every
// triggered category is reported via `alarms` so callers can audit it.
// This file is pure ASCII: non-ASCII code points are referenced by number
// so no literal control or confusable characters appear in the source.

export function cleanText(input: string): {
  text: string;
  alarms: string[];
} {
  if (typeof input !== "string") {
    return { text: "", alarms: [] };
  }
  let text = input;
  let hiddenHtml = false;
  let invisibleChars = false;
  let homoglyph = false;
  let instruction = false;

  // (a) HTML comments are hidden content: drop them entirely.
  COMMENT_RE.lastIndex = 0;
  if (COMMENT_RE.test(text)) {
    hiddenHtml = true;
  }
  COMMENT_RE.lastIndex = 0;
  text = text.replace(COMMENT_RE, " ");

  // (b) Hidden elements go away together with their inner content.
  HIDDEN_PAIR_RE.lastIndex = 0;
  if (HIDDEN_PAIR_RE.test(text)) {
    hiddenHtml = true;
  }
  HIDDEN_PAIR_RE.lastIndex = 0;
  text = text.replace(HIDDEN_PAIR_RE, " ");

  // Lone hidden tags (e.g. <input type="hidden">) still raise the alarm.
  TAG_SCAN_RE.lastIndex = 0;
  const leftoverTags = text.match(TAG_SCAN_RE) ?? [];
  if (leftoverTags.some((tag) => HIDDEN_TAG_RE.test(tag))) {
    hiddenHtml = true;
  }

  // (c) Strip all remaining tags but keep their inner text.
  text = text.replace(TAG_RE, " ");

  // (d) Delete invisible characters.
  const chars = Array.from(text);
  if (chars.some((ch) => isInvisible(ch.codePointAt(0) ?? 0))) {
    invisibleChars = true;
  }
  text = chars.filter((ch) => !isInvisible(ch.codePointAt(0) ?? 0)).join("");

  // (e) NFKC-normalize, map confusables in mixed-script tokens, and strip
  // any residual non-ASCII from tokens that still mix Latin with
  // Cyrillic/Greek ranges.
  const normalized = text.normalize("NFKC");
  if (normalized !== text) {
    homoglyph = true;
    text = normalized;
  }
  text = text
    .split(/(\s+)/)
    .map((token) => {
      const cps = Array.from(token).map((ch) => ch.codePointAt(0) ?? 0);
      const hasLatin = /[A-Za-z]/.test(token);
      const hasOther = cps.some((cp) => isCyrillicGreek(cp));
      if (hasLatin && hasOther) {
        homoglyph = true;
        const mapped = Array.from(token)
          .map((ch) => CONFUSABLES.get(ch) ?? ch)
          .join("");
        return Array.from(mapped)
          .filter((ch) => (ch.codePointAt(0) ?? 0) <= 0x7f)
          .join("");
      }
      return token;
    })
    .join("");

  // (f) Drop instruction-shaped lines.
  const lines = text.split("\n");
  const kept = lines.filter((line) => {
    if (INSTRUCTION_PATTERNS.some((re) => re.test(line))) {
      instruction = true;
      return false;
    }
    return true;
  });

  // (g) Collapse whitespace runs and blank lines, then trim.
  text = kept
    .map((line) => line.replace(SPACE_RUN_RE, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");

  const alarms: string[] = [];
  if (hiddenHtml) {
    alarms.push("hidden-html");
  }
  if (invisibleChars) {
    alarms.push("invisible-chars");
  }
  if (homoglyph) {
    alarms.push("homoglyph");
  }
  if (instruction) {
    alarms.push("instruction");
  }
  return { text, alarms };
}

// [code point, latin equivalent] for Cyrillic/Greek lookalikes.
const CONFUSABLE_PAIRS: Array<[number, string]> = [
  [0x0410, "A"],
  [0x0412, "B"],
  [0x0421, "C"],
  [0x0415, "E"],
  [0x041d, "H"],
  [0x0406, "I"],
  [0x0408, "J"],
  [0x041a, "K"],
  [0x041c, "M"],
  [0x041e, "O"],
  [0x0420, "P"],
  [0x0422, "T"],
  [0x0425, "X"],
  [0x0430, "a"],
  [0x0441, "c"],
  [0x0435, "e"],
  [0x0456, "i"],
  [0x0458, "j"],
  [0x043e, "o"],
  [0x0440, "p"],
  [0x0445, "x"],
  [0x0443, "y"],
  [0x0391, "A"],
  [0x0392, "B"],
  [0x0395, "E"],
  [0x0397, "H"],
  [0x0399, "I"],
  [0x039a, "K"],
  [0x039c, "M"],
  [0x039d, "N"],
  [0x039f, "O"],
  [0x03a1, "P"],
  [0x03a4, "T"],
  [0x03a7, "X"],
  [0x03b1, "a"],
  [0x03b5, "e"],
  [0x03b7, "n"],
  [0x03b9, "i"],
  [0x03ba, "k"],
  [0x03bd, "v"],
  [0x03bf, "o"],
  [0x03c1, "p"],
  [0x03c4, "t"],
  [0x03c5, "u"],
  [0x03c7, "x"],
];

const CONFUSABLES = new Map<string, string>(
  CONFUSABLE_PAIRS.map(([cp, latin]) => [String.fromCodePoint(cp), latin]),
);

function isCyrillicGreek(cp: number): boolean {
  return (cp >= 0x0400 && cp <= 0x04ff) || (cp >= 0x0370 && cp <= 0x03ff);
}

function isInvisible(cp: number): boolean {
  return (
    (cp >= 0x0000 && cp <= 0x0008) ||
    cp === 0x000b ||
    cp === 0x000c ||
    (cp >= 0x000e && cp <= 0x001f) ||
    cp === 0x007f ||
    cp === 0x00ad ||
    cp === 0x034f ||
    cp === 0x061c ||
    cp === 0x180e ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    cp === 0xfeff ||
    (cp >= 0xe0000 && cp <= 0xe007f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

// Extra unicode spaces collapsed alongside ASCII whitespace runs.
const EXTRA_SPACES = [
  0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
  0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
].map((cp) => String.fromCodePoint(cp));

const SPACE_RUN_RE = new RegExp(
  `[ \\t\\r\\f\\v${EXTRA_SPACES.join("")}]+`,
  "g",
);

// Style/attribute markers that make an element hidden (display:none,
// visibility:hidden, zero opacity, clipping, off-screen absolute position,
// zero-size overflow boxes, the hidden attribute, hidden inputs).
const HIDDEN_MARKER_SOURCE =
  "display\\s*:\\s*none|visibility\\s*:\\s*hidden|opacity\\s*:\\s*0" +
  "|overflow\\s*:\\s*hidden|clip\\s*:|clip-path|-9999px";

// Hidden element removed together with its inner content.
const HIDDEN_PAIR_RE = new RegExp(
  `<([a-zA-Z][a-zA-Z0-9]*)\\b[^>]*?(?:${HIDDEN_MARKER_SOURCE}|\\bhidden\\b|type\\s*=\\s*["']?hidden["']?)[^>]*>[\\s\\S]*?</\\1\\s*>`,
  "gis",
);

// Detects a lone (self-closing or unmatched) tag that carries a hidden marker.
const HIDDEN_TAG_RE = new RegExp(
  `(?:${HIDDEN_MARKER_SOURCE}|\\bhidden\\b|type\\s*=\\s*["']?hidden["']?)`,
  "i",
);

const COMMENT_RE = /<!--[\s\S]*?-->/g;
const TAG_RE = /<\/?[a-zA-Z!][^>]*>/g;
const TAG_SCAN_RE = /<[^>]*>/g;

// Lines shaped like prompt-injection instructions are dropped wholesale.
const INSTRUCTION_PATTERNS: RegExp[] = [
  /ignore\s+(all|previous|prior|earlier|any|these|your)\s+instructions?/i,
  /disregard\b[\s\S]*?\binstructions?\b/i,
  /exfiltrat\w*/i,
  /reveal\s+(your\s+)?(keys|secrets?|system\s*prompt|passwords?)\b/i,
  /system\s*prompt/i,
  /you\s+are\s+now\b/i,
  /\bnew\s+instructions?\b/i,
  /bypass\s+safety/i,
];
