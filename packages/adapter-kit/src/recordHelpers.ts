import { CanonicalTimestampSchema, type Hunk, ProviderTimestampSchema } from '@salidium/protocol';

/**
 * Normalizes a provider timestamp at the adapter boundary.
 *
 * Providers may use any RFC 3339 precision and an explicit numeric offset. JavaScript's
 * `Date.parse` accepts many locale-dependent strings too, so the shape is checked before it is
 * parsed; a bare local time must never silently acquire the daemon's timezone.
 */
export function normalizeProviderTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const timestamp = value.trim();
  if (!ProviderTimestampSchema.safeParse(timestamp).success) return undefined;
  const millis = Date.parse(timestamp);
  if (!Number.isFinite(millis)) return undefined;
  const normalized = new Date(millis).toISOString();
  return CanonicalTimestampSchema.safeParse(normalized).success ? normalized : undefined;
}

/** Head + tail excerpt that always preserves the tail (test summaries live there). */
export function excerpt(
  text: string,
  headChars = 6000,
  tailChars = 6000,
): { text: string; truncated: boolean } {
  if (text.length <= headChars + tailChars) return { text, truncated: false };
  const head = text.slice(0, headChars);
  const tail = text.slice(text.length - tailChars);
  const omitted = text.length - headChars - tailChars;
  return { text: `${head}\n… [${omitted} chars omitted by Salidium] …\n${tail}`, truncated: true };
}

export function countHunkLines(hunks: Hunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.startsWith('+')) added++;
      else if (l.startsWith('-')) removed++;
    }
  }
  return { added, removed };
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parses unified diff text (git / Codex apply_patch style) into hunks. */
export function hunksFromUnifiedDiff(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  for (const raw of diff.split('\n')) {
    const m = HUNK_HEADER.exec(raw);
    if (m) {
      current = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('\\ No newline')) continue;
    if (raw === '') continue;
    if (raw.startsWith('+') || raw.startsWith('-') || raw.startsWith(' ')) current.lines.push(raw);
  }
  return hunks;
}

export function safeJson(line: string): unknown | undefined {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function asObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

const PATH_ARGUMENT = /^(?:path|paths|file|files|file_?path|file_?paths|uri|uris)$/i;
const MAX_PATH_ARGUMENTS = 32;
const MAX_PATH_ARGUMENT_CHARS = 1000;

/**
 * Captures MCP path-bearing arguments before their human-readable JSON excerpt is clipped.
 * Keeping this small, structured list lets downstream redaction make a security decision from
 * the original argument shape without retaining an unbounded duplicate of the tool input.
 */
export function pathArgumentMetadata(value: unknown): { paths: string[]; truncated: boolean } {
  const paths: string[] = [];
  const seen = new Set<string>();
  let truncated = false;
  const visit = (current: unknown, pathContext: boolean, root = false): void => {
    if (typeof current === 'string') {
      // Some filesystem MCPs accept a bare path instead of an object.
      if ((pathContext || root) && current && !seen.has(current)) {
        seen.add(current);
        if (paths.length >= MAX_PATH_ARGUMENTS) {
          truncated = true;
        } else {
          // Preserve the basename as well as the head when a hostile or malformed path is huge.
          const bounded =
            current.length <= MAX_PATH_ARGUMENT_CHARS
              ? current
              : `${current.slice(0, 490)}…${current.slice(-490)}`;
          paths.push(bounded);
        }
      }
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item, pathContext);
      return;
    }
    if (current === null || typeof current !== 'object') return;
    for (const [key, child] of Object.entries(current)) {
      visit(child, pathContext || PATH_ARGUMENT.test(key));
    }
  };
  visit(value, false, true);
  return { paths, truncated };
}
