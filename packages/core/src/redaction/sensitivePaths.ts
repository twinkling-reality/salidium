import type { ToolInput } from '@salidium/protocol';

/**
 * Paths whose *contents* must never be persisted or shown, even when a tool read them.
 * Matching is by basename or path suffix; conservative and user-extensible later.
 */
const SENSITIVE_BASENAMES = new Set([
  '.env',
  '.envrc',
  '.flaskenv',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.pgpass',
  '.my.cnf',
  '.git-credentials',
  'auth.json',
  'credentials',
  'credentials.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'known_hosts',
  '.claude.json',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
]);

const SENSITIVE_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.[\w.-]+)?$/,
  /\.(pem|key|p12|pfx|jks|keystore|asc|gpg|ppk|tfvars|tfstate)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|\/)\.ssh\//,
  /(^|\/)\.aws\//,
  /(^|\/)\.gnupg\//,
  /(^|\/)\.config\/gcloud\//,
  /(^|\/)\.kube\/config$/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)service-account[\w.-]*\.json$/i,
  /(^|\/)\.claude\/settings(\.local)?\.json$/,
  /(^|\/)\.codex\/(auth\.json|config\.toml)$/,
];

/** A secret file by name: `app-secrets.yaml`, `secret.json`, `prod.secret.env`. */
function isSecretFileName(base: string): boolean {
  return base.includes('secret') && /^[\w.-]+$/.test(base) && /\.(ya?ml|json|toml|env)$/.test(base);
}

/**
 * Decoding layers tried beyond the first. A tool or a chain of them may decode more than once;
 * past this many layers the spelling is treated as sensitive rather than decoded further.
 */
const MAX_EXTRA_DECODES = 3;
/** Longer than any real path (Linux PATH_MAX is 4096); treated as sensitive, not scanned. */
const MAX_PATH_CHARS = 4096;
const ESCAPE = /%[0-9a-f]{2}/i;

/** Decodes each run of escapes that is valid UTF-8 and leaves the rest as written. */
function decodeLeniently(value: string): string {
  return value.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** Without the C0 controls and spaces at either end, as WHATWG URL parsing removes them. */
function trimControls(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--;
  return value.slice(start, end);
}

/**
 * A `file:` URI's path. The authority (`localhost`, a UNC host) is dropped, and so are a query
 * and a fragment, which a URI path holds only escaped. Anything else is returned as given.
 */
function fileUriPath(value: string): string | undefined {
  const match = /^file:(.*)$/is.exec(value);
  if (!match) return undefined;
  let rest = match[1] ?? '';
  if (rest.startsWith('//')) {
    const slash = rest.indexOf('/', 2);
    rest = slash < 0 ? '' : rest.slice(slash);
  }
  return rest.replace(/[?#].*$/s, '');
}

/**
 * Lexical forms of one spelling: separators unified, duplicates and `.` segments collapsed, the
 * trailing dots and whitespace Windows ignores trimmed, and NFKC plus lower case for
 * case-insensitive filesystems (the macOS default). A `..` is kept in one form and resolved in
 * another, since a symlink may make either the file actually opened. A Windows drive-relative
 * prefix (`C:.env`) and NTFS stream suffixes (`.env::$DATA`, `.ssh::$INDEX_ALLOCATION`) are
 * dropped in a further form. Nothing touches the real filesystem.
 */
function lexicalForms(spelling: string): string[] {
  const unified = spelling.normalize('NFKC').toLowerCase().replace(/\\/g, '/');
  const absolute = unified.startsWith('/');
  const kept: string[] = [];
  const resolved: string[] = [];
  for (const raw of unified.split('/')) {
    const segment = /^\.+$/.test(raw) ? raw : raw.replace(/[.\s]+$/, '');
    if (segment === '' || segment === '.') continue;
    kept.push(segment);
    if (segment === '..') {
      if (resolved.length && resolved[resolved.length - 1] !== '..') resolved.pop();
      else if (!absolute) resolved.push(segment);
    } else resolved.push(segment);
  }
  const join = (segments: string[]) => (absolute ? '/' : '') + segments.join('/');
  const streamless = (segments: string[]) =>
    segments.map((segment, i) => {
      const local = i === 0 && /^[a-z]:./.test(segment) ? segment.slice(2) : segment;
      const colon = local.indexOf(':');
      return colon > 0 ? local.slice(0, colon) : local;
    });
  return [
    spelling.replace(/\\/g, '/'),
    unified,
    join(kept),
    join(resolved),
    join(streamless(kept)),
    join(streamless(resolved)),
  ];
}

/**
 * What a value may be before decoding: as given, trimmed, and for a `file:` URI as WHATWG URL
 * parsing (which Node's `fileURLToPath` uses) reads it, with tabs and newlines removed anywhere.
 */
function rawSpellings(path: string): string[] {
  const out = new Set([path, path.trim()]);
  const trimmed = trimControls(path);
  if (/^file:/i.test(trimmed)) {
    const cleaned = trimmed.replace(/[\t\n\r]/g, '');
    out.add(cleaned);
    try {
      out.add(new URL(cleaned).pathname);
    } catch {
      // Not a parseable URL; the textual forms above still apply.
    }
  }
  return [...out];
}

/**
 * Every spelling a path argument might be opened as: as given, as a `file:` URI's path, and
 * percent-decoded (repeatedly, for a value encoded more than once), each with the text before a
 * NUL. Undefined means the argument cannot be read with confidence: a malformed escape in the
 * first decoding, or encoding nested deeper than the bound. Callers treat that as sensitive.
 */
function pathSpellings(path: string, decode: boolean): Set<string> | undefined {
  const spellings = new Set<string>();
  const add = (value: string) => {
    spellings.add(value);
    const uri = fileUriPath(value);
    if (uri !== undefined) spellings.add(uri);
  };
  for (const raw of rawSpellings(path)) {
    add(raw);
    if (!decode || !raw.includes('%')) continue;
    let current: string;
    try {
      current = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    add(current);
    // The first layer decoded cleanly, so a `%` left in it may be a literal one. Further layers
    // are speculative and lenient: a malformed escape there stays as written.
    for (let layer = 0; ESCAPE.test(current); layer++) {
      if (layer === MAX_EXTRA_DECODES) return undefined;
      const next = decodeLeniently(current);
      if (next === current) break;
      add(next);
      current = next;
    }
  }
  for (const value of [...spellings]) {
    const nul = value.indexOf('\0');
    if (nul >= 0) spellings.add(value.slice(0, nul));
  }
  return spellings;
}

function matchesSensitive(norm: string): boolean {
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  if (SENSITIVE_BASENAMES.has(base) || isSecretFileName(base)) return true;
  return SENSITIVE_PATTERNS.some((p) => p.test(norm));
}

function isSensitiveSpelling(path: string, decode: boolean): boolean {
  if (path.length > MAX_PATH_CHARS) return true;
  const spellings = pathSpellings(path, decode);
  if (spellings === undefined) return true;
  const checked = new Set<string>();
  for (const spelling of spellings) {
    for (const form of lexicalForms(spelling)) {
      if (checked.has(form)) continue;
      checked.add(form);
      if (matchesSensitive(form)) return true;
    }
  }
  return false;
}

/**
 * Whether a path argument names a sensitive file, however it is spelled: a `file:` URI,
 * percent-encoded, with doubled separators, `.` or `..` segments, trailing dots, an NTFS stream,
 * or in another case. The comparison is lexical only; the real filesystem is never consulted.
 */
export function isSensitivePath(path: string): boolean {
  return isSensitiveSpelling(path, true);
}

type McpInput = Extract<ToolInput, { kind: 'mcp' }>;

const MCP_FILE_READ_TOOLS = new Set([
  'read_file',
  'read_text_file',
  'read_multiple_files',
  'get_file_contents',
  'get_contents',
  'read_media_file',
]);

function normalizeToolName(tool: string): string {
  return tool
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function isPathArgument(key: string): boolean {
  return /^(?:path|paths|file|files|file_?path|file_?paths|uri|uris)$/i.test(key);
}

function sensitivePathArgument(value: unknown, pathContext = false): boolean {
  if (typeof value === 'string') return pathContext && isSensitivePath(value);
  if (Array.isArray(value)) return value.some((item) => sensitivePathArgument(item, pathContext));
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    sensitivePathArgument(child, pathContext || isPathArgument(key)),
  );
}

/** A JSON string's value, escapes included; a single-quoted one only loses its quotes. */
function unquote(quoted: string): string {
  if (quoted.startsWith('"')) {
    try {
      return JSON.parse(quoted) as string;
    } catch {
      // A malformed escape: the text between the quotes is checked as written.
    }
  }
  return quoted.slice(1, -1);
}

/**
 * Recognizes the narrowly scoped MCP equivalent of a file read. MCP results are otherwise
 * generic text, so without tying the result back to its call a read of `.env` bypasses the
 * structural file-read suppression used by native tools.
 */
export function isSensitiveMcpFileRead(input: McpInput): boolean {
  if (!MCP_FILE_READ_TOOLS.has(normalizeToolName(input.tool))) return false;
  // A filesystem read with path metadata beyond the bound is suppressed conservatively: the
  // omitted entry may be the sensitive one, and selecting the first N must not become a bypass.
  if (input.pathArgsTruncated) return true;
  if (input.pathArgs?.some(isSensitivePath)) return true;
  const args = input.argsExcerpt;
  if (!args) return false;
  try {
    const parsed = JSON.parse(args) as unknown;
    // A few filesystem MCPs accept a bare path string instead of an object.
    return typeof parsed === 'string' ? isSensitivePath(parsed) : sensitivePathArgument(parsed);
  } catch {
    // Excerpts can be clipped before they reach this layer. Recover complete, quoted path-like
    // fields only, alone or in a list; scanning all strings would suppress unrelated
    // database/browser MCP evidence. A quote or a backslash may be escaped inside the value.
    const fields =
      /["'](?:path|paths|file|files|file_?path|file_?paths|uri|uris)["']\s*:\s*(\[\s*)?((?:"(?:[^"\\]|\\.)*"\s*,\s*)*"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gi;
    for (const match of args.matchAll(fields)) {
      for (const quoted of (match[2] ?? '').matchAll(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g))
        if (isSensitivePath(unquote(quoted[0]))) return true;
    }
    return false;
  }
}

const ENV_OUTPUT_COMMANDS = new Set(['printenv', 'set', 'export']);
const FILE_OUTPUT_COMMANDS = new Set([
  'cat',
  'less',
  'more',
  'head',
  'tail',
  'bat',
  'sed',
  'awk',
  'grep',
  'rg',
]);

/** Character codes of bash's named ANSI-C escapes (`$'\n'`). */
const ANSI_C_NAMED: Record<string, number> = {
  a: 7,
  b: 8,
  e: 27,
  E: 27,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
};

/** Decodes the ANSI-C escape after a backslash at `start`; `used` counts the characters read. */
function ansiCEscape(chars: string[], start: number): { text: string; used: number } {
  const c = chars[start];
  if (c === undefined) return { text: '\\', used: 0 };
  const digits = (pattern: RegExp, from: number, max: number) => {
    let out = '';
    while (out.length < max && pattern.test(chars[from + out.length] ?? '')) {
      out += chars[from + out.length];
    }
    return out;
  };
  if (c === 'x' || c === 'u' || c === 'U') {
    const hex = digits(/^[0-9a-f]$/i, start + 1, c === 'x' ? 2 : c === 'u' ? 4 : 8);
    if (hex) {
      const code = Number.parseInt(hex, 16);
      return { text: code <= 0x10ffff ? String.fromCodePoint(code) : '', used: 1 + hex.length };
    }
  }
  const octal = digits(/^[0-7]$/, start, 3);
  if (octal)
    return { text: String.fromCharCode(Number.parseInt(octal, 8) & 0xff), used: octal.length };
  const named = ANSI_C_NAMED[c];
  return { text: named === undefined ? c : String.fromCharCode(named), used: 1 };
}

/** Minimal shell tokenization for command-aware output suppression, without executing input. */
function shellSegments(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = '';
  let quote: "'" | '"' | "$'" | undefined;
  let escaped = false;
  const flushWord = () => {
    if (word) words.push(word);
    word = '';
  };
  const flushSegment = () => {
    flushWord();
    if (words.length) segments.push(words);
    words = [];
  };
  const chars = [...command];
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i] ?? '';
    if (escaped) {
      word += char;
      escaped = false;
      continue;
    }
    // Bash's `$'...'` decodes escapes, so `$'\x2eenv'` names `.env`.
    if (quote === "$'") {
      if (char === "'") quote = undefined;
      else if (char === '\\') {
        const decoded = ansiCEscape(chars, i + 1);
        word += decoded.text;
        i += decoded.used;
      } else word += char;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else word += char;
      continue;
    }
    if (char === '$' && (chars[i + 1] === "'" || chars[i + 1] === '"')) {
      quote = chars[i + 1] === "'" ? "$'" : '"';
      i++;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (char === '\n' || char === '\r') flushSegment();
      else flushWord();
      continue;
    }
    if (char === '|' || char === ';' || char === '&') {
      flushSegment();
      continue;
    }
    if (char === '<' || char === '>') {
      flushWord();
      continue;
    }
    word += char;
  }
  flushSegment();
  return segments;
}

function executableName(token: string): string {
  const normalized = token.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function envCommandIsDump(args: string[]): boolean {
  let i = 0;
  while (i < args.length) {
    const arg = args[i] ?? '';
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
      i++;
      continue;
    }
    if (arg === '-u' || arg === '--unset' || arg === '-C' || arg === '--chdir' || arg === '-S') {
      i += 2;
      continue;
    }
    if (arg.startsWith('-')) {
      i++;
      continue;
    }
    return false;
  }
  return true;
}

export function isCredentialDumpCommand(command: string): boolean {
  for (const segment of shellSegments(command)) {
    let start = 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[start] ?? '')) start++;
    const executable = executableName(segment[start] ?? '');
    const args = segment.slice(start + 1);
    if (ENV_OUTPUT_COMMANDS.has(executable)) return true;
    if (executable === 'env' && envCommandIsDump(args)) return true;
    // A shell passes its words through undecoded, so a `%` here is literal (an awk or grep
    // pattern, often) and is not percent-decoded; the other normalizations still apply.
    if (FILE_OUTPUT_COMMANDS.has(executable) && args.some((arg) => isSensitiveSpelling(arg, false)))
      return true;
  }
  return false;
}
