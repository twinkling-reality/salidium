export function timeOfDay(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function dateTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/**
 * How long something ran, rolled up the way `relativeTime` above already rolls up.
 *
 * It stopped at minutes, so long sessions printed values a reader had to divide by hand. Two
 * units, never three: `2h 14m` says everything
 * `2h 14m 8s` does at the scale where the seconds no longer decide anything.
 */
export function durationMs(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m ${Math.round((ms % 60_000) / 1000)}s`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h ${totalMinutes % 60}m`;
  return `${Math.floor(totalHours / 24)}d ${totalHours % 24}h`;
}

export function shortPath(path: string, cwd?: string): string {
  let p = normalizePath(path);
  const root = cwd ? normalizePath(cwd).replace(/\/$/, '') : undefined;
  if (root && p.startsWith(`${root}/`)) p = p.slice(root.length + 1);
  return p;
}

/**
 * Home-relative every path *inside* a line of shell, not just one at its head.
 *
 * A command is not a path, so `shortPath` cannot help it, and a home prefix repeated in a 300 px
 * column is most of the column: `rm -rf /Users/someone/dev/sample-app/.cache-tool` wraps
 * over three lines and breaks mid-word, while the `~` form fits on one. It is the same
 * substitution the masthead and the file lists already make, so `~` means the same thing
 * everywhere it appears.
 */
export function shortHome(text: string): string {
  return text
    .replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s'"]+/g, '~')
    .replace(/\/(?:Users|home)\/[^/\s'"]+/g, '~');
}

/**
 * The deepest directory every one of these paths sits under, as a prefix ending in `/`.
 *
 * The session's cwd is not a reliable root — an agent run from a worktree or a temp directory has
 * a cwd that matches none of the files it edits, and then every row prints its whole path and the
 * shared two thirds are repeated down the column. The files themselves always agree on a root.
 */
export function commonDir(paths: string[]): string {
  const normalized = paths.map(normalizePath);
  const first = normalized[0];
  if (!first || paths.length < 2) return '';
  const parts = first.split('/');
  let end = parts.length - 1;
  for (const p of normalized) {
    const q = p.split('/');
    let i = 0;
    while (i < end && i < q.length - 1 && q[i] === parts[i]) i++;
    end = i;
    if (end === 0) return '';
  }
  return `${parts.slice(0, end).join('/')}/`;
}

export function basename(path: string): string {
  const normalized = normalizePath(path);
  const i = normalized.lastIndexOf('/');
  return i >= 0 ? normalized.slice(i + 1) : normalized;
}

export function dirname(path: string): string {
  const normalized = normalizePath(path);
  const i = normalized.lastIndexOf('/');
  return i > 0 ? normalized.slice(0, i) : '';
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
