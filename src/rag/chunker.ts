export type TextChunk = {
  ordinal: number;
  sectionRef: string | null;
  text: string;
};

export type ChunkOptions = {
  /** Soft ceiling per chunk, in approximate tokens. */
  maxTokens?: number;
  /** Fragments smaller than this are merged into the next section rather than standing alone. */
  minTokens?: number;
  /** Fraction of a chunk repeated at the start of the next one when a section is split. */
  overlap?: number;
};

// A section stays its own chunk so citations point at one article; only fragments too
// small to retrieve on (a title line, a one-line preamble) are merged forward.
const DEFAULTS = { maxTokens: 1200, minTokens: 60, overlap: 0.1 };

/** Rough token estimate (~4 characters per token for English legal prose). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Headings that start a new citable unit in EU and US regulatory text.
const HEADING =
  /^(?:Article\s+\d+[a-z]?\b.*|(?:Section|Sec\.)\s+\d+[\w.-]*\b.*|§\s*\d+[\w.()-]*.*|(?:PART|Part|CHAPTER|Chapter|SUBPART|Subpart)\s+[\dIVXLC]+[A-Z]?\b.*|[IVXLC]+\.\s+[A-Z].*)$/;

type Section = { ref: string | null; text: string };

export function splitSections(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { ref: null, text: "" };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length <= 140 && HEADING.test(line)) {
      if (current.text.trim()) sections.push(current);
      current = { ref: sectionRefFromHeading(line), text: line + "\n" };
    } else {
      current.text += rawLine + "\n";
    }
  }
  if (current.text.trim()) sections.push(current);
  return sections;
}

function sectionRefFromHeading(line: string): string {
  const match = line.match(
    /^(Article\s+\d+[a-z]?|(?:Section|Sec\.)\s+\d+[\w.-]*|§\s*\d+[\w.()-]*|(?:PART|Part|CHAPTER|Chapter|SUBPART|Subpart)\s+[\dIVXLC]+[A-Z]?|[IVXLC]+\.)/,
  );
  return (match?.[1] ?? line).replace(/\s+/g, " ").replace(/\.$/, "").trim();
}

/** Splits an over-long section on paragraph, then sentence, boundaries with overlap. */
function splitLong(text: string, maxChars: number, overlapChars: number): string[] {
  const units = text
    .split(/\n+/)
    .flatMap((p) => (p.length > maxChars ? (p.match(/[^.;]+[.;]?\s*/g) ?? [p]) : [p + "\n"]))
    .filter((u) => u.trim());
  const out: string[] = [];
  let buf = "";
  for (const unit of units) {
    if (buf && buf.length + unit.length > maxChars) {
      out.push(buf.trim());
      buf = buf.slice(Math.max(0, buf.length - overlapChars));
    }
    // A single unit longer than the budget is hard-split as a last resort.
    if (unit.length > maxChars) {
      for (let i = 0; i < unit.length; i += maxChars - overlapChars) {
        out.push((buf + unit.slice(i, i + maxChars - buf.length)).trim());
        buf = "";
      }
      continue;
    }
    buf += unit;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/**
 * Section-aware chunking: split on article/section headings, merge small
 * neighbouring sections up to the token budget, and split oversized sections
 * with overlap. Every chunk keeps the section reference it starts in.
 */
export function chunkRuleText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const { maxTokens, minTokens, overlap } = { ...DEFAULTS, ...options };
  const maxChars = maxTokens * 4;
  const minChars = minTokens * 4;
  const overlapChars = Math.floor(maxChars * overlap);

  const pieces: Section[] = [];
  for (const section of splitSections(text)) {
    if (section.text.length <= maxChars) {
      pieces.push({ ref: section.ref, text: section.text.trim() });
    } else {
      for (const part of splitLong(section.text, maxChars, overlapChars)) {
        pieces.push({ ref: section.ref, text: part });
      }
    }
  }

  const chunks: TextChunk[] = [];
  let buf: Section | null = null;
  const flush = () => {
    if (buf && buf.text.trim()) {
      chunks.push({ ordinal: chunks.length, sectionRef: buf.ref, text: buf.text.trim() });
    }
    buf = null;
  };
  for (const piece of pieces) {
    if (!buf) {
      buf = { ...piece };
    } else if (buf.text.length < minChars && buf.text.length + piece.text.length + 2 <= maxChars) {
      buf = { ref: buf.ref ?? piece.ref, text: `${buf.text}\n\n${piece.text}` };
    } else {
      flush();
      buf = { ...piece };
    }
  }
  flush();
  return chunks;
}

export type CodeChunkDraft = { startLine: number; endLine: number; text: string };

/** Fixed-window line chunking for source files; line numbers are 1-based and inclusive. */
export function chunkCode(source: string, windowLines = 40, overlapLines = 8): CodeChunkDraft[] {
  const lines = source.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const out: CodeChunkDraft[] = [];
  const step = Math.max(1, windowLines - overlapLines);
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + windowLines);
    const text = lines.slice(start, end).join("\n");
    if (text.trim()) out.push({ startLine: start + 1, endLine: end, text });
    if (end === lines.length) break;
  }
  return out;
}
