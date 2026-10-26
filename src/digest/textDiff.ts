/** Small text utilities shared by the digest analysts. */

export type ChangedLines = { added: string[]; removed: string[] };

const lineSet = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

/**
 * Lines present in one version and not the other, in document order and
 * without repeats. A line-set difference, not an alignment, which is enough
 * to show a model (or a person) where an amendment touched the text.
 */
export function changedLines(previous: string, current: string): ChangedLines {
  const before = lineSet(previous);
  const after = lineSet(current);
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const unique = (lines: string[], other: Set<string>) => [...new Set(lines.filter((line) => !other.has(line)))];
  return { added: unique(after, beforeSet), removed: unique(before, afterSet) };
}

/** "+ added line" / "- removed line", capped at `maxChars` with a note of what was left out. */
export function formatChangedLines(diff: ChangedLines, maxChars = 6_000): string {
  const lines = [...diff.removed.map((l) => `- ${l}`), ...diff.added.map((l) => `+ ${l}`)];
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > maxChars) {
      out.push(`… ${lines.length - out.length} more changed line(s) omitted`);
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out.join("\n");
}

/** Sentences of a text, in order, trimmed; list markers and headings are kept as their own entries. */
export function sentences(text: string): string[] {
  return text
    .split(/\r?\n+|(?<=[.!?])\s+(?=[A-Z(“"'])/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}
