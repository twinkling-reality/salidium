import { lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';

/*
 * Extra provider sources the owner names in a setting, such as the Codex homes and OpenCode
 * stores another local tool keeps for the agents it runs.
 *
 * A setting is a list of absolute paths separated by `:` (`;` on Windows, as PATH is). A path
 * names one source as it is, read exactly as the provider's default source is read. One component
 * of a path may instead be a pattern holding a single `*`, which stands for any name that does not
 * start with a dot, so that a tool which makes one source per task needs one entry for all of
 * them: `/data/codex-confined/*` or `/data/opencode-sandbox-*` followed by the rest of the path.
 *
 * What a pattern finds was not named by the owner, so nothing it finds may be a link: the folder
 * that matched, every folder after it, and the source itself must be real. A link planted in a
 * folder the owner pointed at cannot redirect a read anywhere else.
 */

/**
 * Matches one pattern is allowed to expand to. Past it, the most recently modified are kept, so a
 * tool that has made many folders over time still has its newest one read.
 */
export const MAX_PATTERN_MATCHES = 256;

/** Entries one setting may hold; the rest are ignored. */
export const MAX_SOURCE_ENTRIES = 32;

export interface SourceEntry {
  /** The path as written, normalized only by dropping a trailing separator. */
  path: string;
  /** Index of the component holding `*`, or undefined for a path named as it is. */
  patternAt?: number;
}

export interface ParsedSourceList {
  entries: SourceEntry[];
  /** Entries that were refused, with the reason, for a setup surface to report. */
  refused: Array<{ entry: string; reason: string }>;
}

const LIST_SEPARATOR = process.platform === 'win32' ? ';' : ':';

/** Parses a setting's value. An absent or empty value is an empty list. */
export function parseSourceList(raw: string | undefined): ParsedSourceList {
  const entries: SourceEntry[] = [];
  const refused: ParsedSourceList['refused'] = [];
  if (!raw) return { entries, refused };
  const seen = new Set<string>();
  for (const part of raw.split(LIST_SEPARATOR)) {
    const written = part.trim();
    if (!written) continue;
    const path =
      written.length > 1 && (written.endsWith('/') || written.endsWith(sep))
        ? written.slice(0, -1)
        : written;
    if (!isAbsolute(path)) {
      refused.push({ entry: written, reason: 'not an absolute path' });
      continue;
    }
    const components = path.split(/[\\/]/);
    if (components.some((c) => c === '.' || c === '..')) {
      refused.push({ entry: written, reason: 'contains . or .. components' });
      continue;
    }
    const patterned = components.flatMap((c, i) => (c.includes('*') ? [i] : []));
    if (patterned.length > 1) {
      refused.push({ entry: written, reason: 'more than one component holds *' });
      continue;
    }
    const at = patterned[0];
    if (at !== undefined && (components[at] ?? '').split('*').length > 2) {
      refused.push({ entry: written, reason: 'a component holds more than one *' });
      continue;
    }
    if (seen.has(path)) continue;
    if (entries.length >= MAX_SOURCE_ENTRIES) {
      refused.push({ entry: written, reason: `more than ${MAX_SOURCE_ENTRIES} entries` });
      continue;
    }
    seen.add(path);
    entries.push(at === undefined ? { path } : { path, patternAt: at });
  }
  return { entries, refused };
}

function lstatOf(
  path: string,
): { kind: 'directory' | 'file' | 'other'; mtimeMs: number } | undefined {
  try {
    const st = lstatSync(path);
    const kind = st.isSymbolicLink()
      ? 'other'
      : st.isDirectory()
        ? 'directory'
        : st.isFile()
          ? 'file'
          : 'other';
    return { kind, mtimeMs: st.mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * The sources one entry names now. A plain entry is returned as written, whether or not it exists
 * yet, and the caller checks it exactly as it checks the provider's default source. A pattern is
 * expanded against what is on disk: each match, and every component after it, must be a real
 * directory, and the last must be a real `kind` (never a link). At most `MAX_PATTERN_MATCHES`, the
 * most recently modified when there are more, returned in name order.
 */
export function expandSourceEntry(entry: SourceEntry, kind: 'directory' | 'file'): string[] {
  if (entry.patternAt === undefined) return [entry.path];
  const components = entry.path.split(/[\\/]/);
  const pattern = components[entry.patternAt] ?? '';
  const star = pattern.indexOf('*');
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  const parent = components.slice(0, entry.patternAt).join(sep) || sep;
  const rest = components.slice(entry.patternAt + 1);
  let names: string[];
  try {
    names = readdirSync(parent, { withFileTypes: true })
      // A Dirent for a link is a link, never a directory, so a planted link is not a match.
      .filter((d) => d.isDirectory() || (rest.length === 0 && kind === 'file' && d.isFile()))
      .map((d) => d.name)
      .filter(
        (name) =>
          !name.startsWith('.') &&
          name.length >= prefix.length + suffix.length + 1 &&
          name.startsWith(prefix) &&
          name.endsWith(suffix),
      )
      .sort();
  } catch {
    return [];
  }
  const found: Array<{ path: string; mtimeMs: number }> = [];
  for (const name of names) {
    let path = join(parent, name);
    let st = lstatOf(path);
    let ok = st?.kind === (rest.length === 0 ? kind : 'directory');
    for (const [i, component] of rest.entries()) {
      if (!ok) break;
      path = join(path, component);
      st = lstatOf(path);
      ok = st?.kind === (i === rest.length - 1 ? kind : 'directory');
    }
    if (ok && st) found.push({ path, mtimeMs: st.mtimeMs });
  }
  if (found.length > MAX_PATTERN_MATCHES) {
    found.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
    found.length = MAX_PATTERN_MATCHES;
    found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  return found.map((f) => f.path);
}

/** Every source a setting names now, in the order written, each once. */
export function expandSourceList(raw: string | undefined, kind: 'directory' | 'file'): string[] {
  const out = new Set<string>();
  for (const entry of parseSourceList(raw).entries)
    for (const path of expandSourceEntry(entry, kind)) out.add(path);
  return [...out];
}
