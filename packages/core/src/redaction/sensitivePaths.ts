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
 * How a value's percent-encoding is read. A URI (a `file:` value, or one under a `uri`-type key)
 * is decoded by whatever opens it, so a malformed escape there means the value cannot be read with
 * confidence. In a native path a `%` is usually literal (`100%.md`), so escapes are decoded where
 * valid and the rest kept. A shell passes its words through undecoded.
 */
type Decoding = 'uri' | 'path' | 'none';

/** Whether a value is shaped as a `file:` URI, as WHATWG URL parsing would read it. */
function isFileUri(value: string): boolean {
  return /^file:/i.test(trimControls(value));
}

/**
 * Every spelling a path argument might be opened as: as given, as a `file:` URI's path, and
 * percent-decoded (repeatedly, for a value encoded more than once), each with the text before a
 * NUL. Undefined means the argument cannot be read with confidence: a malformed escape in the
 * first decoding of a URI, or encoding nested deeper than the bound. Callers treat that as
 * sensitive.
 */
function pathSpellings(path: string, decoding: Decoding): Set<string> | undefined {
  const spellings = new Set<string>();
  const add = (value: string) => {
    spellings.add(value);
    const uri = fileUriPath(value);
    if (uri !== undefined) spellings.add(uri);
  };
  const strict = decoding === 'uri' || (decoding === 'path' && isFileUri(path));
  for (const raw of rawSpellings(path)) {
    add(raw);
    if (decoding === 'none' || !raw.includes('%')) continue;
    let current: string;
    if (strict) {
      try {
        current = decodeURIComponent(raw);
      } catch {
        return undefined;
      }
    } else current = decodeLeniently(raw);
    add(current);
    // A `%` left after the first layer may be a literal one. Further layers are speculative
    // and lenient: a malformed escape there stays as written.
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

function isSensitiveSpelling(path: string, decoding: Decoding): boolean {
  if (path.length > MAX_PATH_CHARS) return true;
  const spellings = pathSpellings(path, decoding);
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
 * or in another case. A `file:` value with a malformed escape counts as sensitive; in a native
 * path a `%` that is not a valid escape is literal. The comparison is lexical only; the real
 * filesystem is never consulted.
 */
export function isSensitivePath(path: string): boolean {
  return isSensitiveSpelling(path, 'path');
}

/** A URI with a scheme other than `file:` (`https:`); a one-letter drive (`C:`) is not one. */
const OTHER_SCHEME = /^(?!file:)[a-z][a-z0-9+.-]+:/i;

/**
 * As {@link isSensitivePath}, for a value given as a URI (under a `uri`, `url` or `href` key):
 * a `file:` or scheme-less value with a malformed escape counts as sensitive. A web address
 * (`https://x/?q=100%`) is not a file a tool opens, so its `%` is read as in a path.
 */
export function isSensitiveUri(value: string): boolean {
  return isSensitiveSpelling(value, OTHER_SCHEME.test(trimControls(value)) ? 'path' : 'uri');
}

/** Keys whose values are URIs, decoded by whatever opens them. */
const URI_KEY = /^(?:uri|uris|url|urls|href|hrefs)$/i;

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
  return /^(?:path|paths|file|files|file_?path|file_?paths)$/i.test(key) || URI_KEY.test(key);
}

type PathContext = 'none' | 'path' | 'uri';

function sensitivePathArgument(value: unknown, context: PathContext = 'none'): boolean {
  if (typeof value === 'string')
    return context === 'uri' ? isSensitiveUri(value) : context === 'path' && isSensitivePath(value);
  if (Array.isArray(value)) return value.some((item) => sensitivePathArgument(item, context));
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => {
    const next: PathContext = URI_KEY.test(key)
      ? 'uri'
      : context !== 'none'
        ? context
        : isPathArgument(key)
          ? 'path'
          : 'none';
    return sensitivePathArgument(child, next);
  });
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
  if (input.pathArgsTruncated || input.pathArgsUndecodable) return true;
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
      /["'](path|paths|file|files|file_?path|file_?paths|uri|uris|url|urls|href|hrefs)["']\s*:\s*(\[\s*)?((?:"(?:[^"\\]|\\.)*"\s*,\s*)*"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gi;
    for (const match of args.matchAll(fields)) {
      const check = URI_KEY.test(match[1] ?? '') ? isSensitiveUri : isSensitivePath;
      for (const quoted of (match[3] ?? '').matchAll(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g))
        if (check(unquote(quoted[0]))) return true;
    }
    return false;
  }
}

/** `printenv` prints a value even when named; `set` and `export` print only when bare. */
const ENV_OUTPUT_COMMANDS = new Set(['printenv']);
const BARE_ENV_OUTPUT_COMMANDS = new Set(['set', 'export', 'declare', 'typeset']);

/** Commands that print the contents of a file named in their arguments. */
const FILE_OUTPUT_COMMANDS = new Set([
  'cat',
  'tac',
  'nl',
  'head',
  'tail',
  'less',
  'more',
  'bat',
  'batcat',
  'sed',
  'awk',
  'gawk',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'base64',
  'base32',
  'xxd',
  'od',
  'hexdump',
  'hd',
  'strings',
  'sort',
  'uniq',
  'cut',
  'paste',
  'fold',
  'rev',
  'column',
  'diff',
  'cmp',
  'jq',
  'yq',
  'iconv',
  'dd',
]);

/**
 * How a reader's options and operands are read: which options take a value that is a pattern
 * or program (never a path), a file (checked), or something else (skipped), and whether the first
 * operand is a pattern or program unless an option supplies one. Short options are single
 * letters, so a cluster (`-rne PATTERN`) is read letter by letter. Case matters: `-E` is not `-e`.
 */
interface ReaderSyntax {
  scriptFirst?: boolean;
  pattern?: string[];
  file?: string[];
  value?: string[];
}

const GREP_SYNTAX: ReaderSyntax = {
  scriptFirst: true,
  pattern: ['e', '--regexp'],
  file: ['f', '--file'],
  value: ['A', 'B', 'C', 'm', 'd', 'D', '--max-count', '--context', '--label', '--color'],
};

const READER_SYNTAX: Record<string, ReaderSyntax> = {
  grep: GREP_SYNTAX,
  egrep: GREP_SYNTAX,
  fgrep: GREP_SYNTAX,
  rg: {
    scriptFirst: true,
    pattern: ['e', '--regexp'],
    file: ['f', '--file'],
    value: ['g', 't', 'T', 'A', 'B', 'C', 'm', 'M', 'j', 'E', 'r', '--glob', '--iglob', '--type'],
  },
  sed: {
    scriptFirst: true,
    pattern: ['e', '--expression'],
    file: ['f', '--file'],
    value: ['l', '--line-length'],
  },
  awk: {
    scriptFirst: true,
    pattern: ['e', '--source'],
    file: ['f', '--file'],
    value: ['v', 'F', '--assign', '--field-separator'],
  },
  jq: {
    scriptFirst: true,
    file: ['f', '--from-file'],
    value: ['--indent', '--tab'],
  },
  yq: { scriptFirst: true, file: ['--from-file'], value: ['--indent'] },
};
READER_SYNTAX.gawk = READER_SYNTAX.awk as ReaderSyntax;

/** jq options followed by a name and then a value: the value of the file ones is read. */
const JQ_NAMED_VALUES: Record<string, 'file' | 'value'> = {
  '--arg': 'value',
  '--argjson': 'value',
  '--slurpfile': 'file',
  '--rawfile': 'file',
};

/** What kind of value an option takes for this reader; `--include*` and `--exclude*` are filters. */
function optionKind(syntax: ReaderSyntax, name: string): 'pattern' | 'file' | 'value' | 'flag' {
  if (syntax.pattern?.includes(name)) return 'pattern';
  if (syntax.file?.includes(name)) return 'file';
  if (syntax.value?.includes(name) || /^--(?:include|exclude)/.test(name)) return 'value';
  return 'flag';
}

/**
 * The words a reader is given as files: its operands, less a leading pattern or program, plus the
 * values of options that name a file. Pattern and filter values are never read as paths.
 */
function readerFiles(executable: string, args: string[]): string[] {
  const syntax = READER_SYNTAX[executable] ?? {};
  const files: string[] = [];
  const operands: string[] = [];
  let scriptGiven = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--') {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq < 0 ? arg : arg.slice(0, eq);
      const named = executable === 'jq' ? JQ_NAMED_VALUES[name] : undefined;
      if (named) {
        if (named === 'file' && args[i + 2] !== undefined) files.push(args[i + 2] ?? '');
        i += 2;
        continue;
      }
      const kind = optionKind(syntax, name);
      if (kind === 'flag') {
        // An unknown `--option=value` may name a file; checking it only over-matches.
        if (eq >= 0) files.push(arg.slice(eq + 1));
        continue;
      }
      if (kind === 'pattern' || kind === 'file') scriptGiven = true;
      const value = eq >= 0 ? arg.slice(eq + 1) : args[++i];
      if (kind === 'file' && value !== undefined) files.push(value);
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (let k = 1; k < arg.length; k++) {
        const kind = optionKind(syntax, arg[k] ?? '');
        if (kind === 'flag') continue;
        if (kind === 'pattern' || kind === 'file') scriptGiven = true;
        const value = k + 1 < arg.length ? arg.slice(k + 1) : args[++i];
        if (kind === 'file' && value !== undefined) files.push(value);
        break;
      }
      continue;
    }
    operands.push(arg);
  }
  if (syntax.scriptFirst && !scriptGiven) operands.shift();
  return [...files, ...operands];
}

/**
 * Commands that run the command after them, with the options that take a value and the number of
 * operands before that command (`timeout 5 cat .env`).
 */
const COMMAND_PREFIXES: Record<string, { values?: string[]; operands?: number }> = {
  sudo: {
    values: ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '--user', '--group'],
  },
  doas: { values: ['-u', '-C'] },
  env: { values: ['-u', '--unset', '-C', '--chdir'] },
  command: {},
  builtin: {},
  exec: { values: ['-a'] },
  nohup: {},
  nice: { values: ['-n', '--adjustment'] },
  ionice: { values: ['-c', '-n', '-p', '-P', '-u', '--class', '--classdata'] },
  time: { values: ['-f', '-o', '--format', '--output'] },
  timeout: { values: ['-k', '-s', '--kill-after', '--signal'], operands: 1 },
  stdbuf: { values: ['-i', '-o', '-e'] },
  xargs: {
    values: [
      '-a',
      '-d',
      '-E',
      '-e',
      '-I',
      '-L',
      '-l',
      '-n',
      '-P',
      '-s',
      '--arg-file',
      '--delimiter',
    ],
  },
};

/** Words a command may follow without being part of it. */
const SHELL_KEYWORDS = new Set([
  '!',
  '{',
  '}',
  'then',
  'do',
  'else',
  'elif',
  'if',
  'while',
  'until',
]);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
/** Git subcommands that print a file's contents, or its changes, when given its path. */
const GIT_CONTENT_COMMANDS = new Set([
  'show',
  'cat-file',
  'diff',
  'log',
  'blame',
  'annotate',
  'grep',
  'whatchanged',
  'format-patch',
]);
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Nested scripts (`bash -c "..."`, `$(...)`) followed before the command counts as a dump. */
const MAX_NESTED_SCRIPTS = 4;

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

interface ShellSegment {
  words: string[];
  /** Files read on standard input (`< .env`). */
  inputs: string[];
}

/**
 * Minimal shell tokenization for command-aware output suppression, without executing input. A
 * segment ends at `|`, `;`, `&`, a newline or a parenthesis. A redirection's target is kept apart
 * from the words: an input one is a file read, an output one and a here-document delimiter are
 * dropped.
 */
function shellSegments(command: string): ShellSegment[] {
  const segments: ShellSegment[] = [];
  let words: string[] = [];
  let inputs: string[] = [];
  let word = '';
  let quote: "'" | '"' | "$'" | undefined;
  let escaped = false;
  let redirect: 'in' | 'drop' | undefined;
  const flushWord = () => {
    if (word) {
      if (redirect === 'in') inputs.push(word);
      else if (redirect === undefined) words.push(word);
      redirect = undefined;
    }
    word = '';
  };
  const flushSegment = () => {
    flushWord();
    if (words.length || inputs.length) segments.push({ words, inputs });
    words = [];
    inputs = [];
    redirect = undefined;
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
      // A line continuation joins the lines: `ca\<newline>t .env` runs `cat .env`.
      if (chars[i + 1] === '\n') i++;
      else if (chars[i + 1] === '\r' && chars[i + 2] === '\n') i += 2;
      else escaped = true;
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
    if (char === '|' || char === ';' || char === '&' || char === '(' || char === ')') {
      flushSegment();
      continue;
    }
    if (char === '<') {
      flushWord();
      const next = chars[i + 1];
      if (next === '<' || next === '&') {
        // A here-document's delimiter, a here-string, or a duplicated descriptor: not a file.
        while (chars[i + 1] === '<' || chars[i + 1] === '&') i++;
        redirect = 'drop';
      } else {
        if (next === '>') i++;
        redirect = 'in';
      }
      continue;
    }
    if (char === '>') {
      flushWord();
      while (chars[i + 1] === '>' || chars[i + 1] === '|' || chars[i + 1] === '&') i++;
      redirect = 'drop';
      continue;
    }
    word += char;
  }
  flushSegment();
  return segments;
}

/**
 * Pulls out the scripts a command runs inside it: `$(...)`, backticks and process substitution,
 * innermost first. Quoting is ignored, so a quoted one is checked too; that only over-matches.
 */
function substitutions(command: string): { outer: string; inner: string[] } {
  const inner: string[] = [];
  let outer = command;
  for (let round = 0; round < 16; round++) {
    const next = outer.replace(
      /\$\(([^()]*)\)|[<>]\(([^()]*)\)|`([^`]*)`/g,
      (_match, a?: string, b?: string, c?: string) => {
        inner.push(a ?? b ?? c ?? '');
        return ' _ ';
      },
    );
    if (next === outer) break;
    outer = next;
  }
  return { outer, inner };
}

function executableName(token: string): string {
  const normalized = token.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/**
 * Whether an option takes the next word as its value: named in `values`, or a short-option
 * cluster whose last letter is (`sudo -Eu root`, `env -iu NAME`).
 */
function takesValue(arg: string, values: string[] | undefined): boolean {
  if (!values) return false;
  if (values.includes(arg)) return true;
  return /^-[A-Za-z]{2,}$/.test(arg) && values.includes(`-${arg.at(-1)}`);
}

const ENV_VALUE_OPTIONS = ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'];

/** Whether `env` with these arguments prints the environment rather than running a command. */
function envCommandIsDump(args: string[]): boolean {
  let i = 0;
  while (i < args.length) {
    const arg = args[i] ?? '';
    if (ASSIGNMENT.test(arg)) {
      i++;
      continue;
    }
    // A bare `-` is `-i`.
    if (arg.startsWith('-')) {
      i += takesValue(arg, ENV_VALUE_OPTIONS) ? 2 : 1;
      continue;
    }
    return false;
  }
  return true;
}

interface Invocation {
  executable: string;
  args: string[];
  /** Run by `xargs`, which takes further arguments from its input. */
  viaXargs: boolean;
  /** A script the words carry for a shell to run (`env -S '...'`). */
  script?: string;
}

/** The command a segment runs, past assignments, keywords and prefixes such as `sudo`. */
function invocation(words: string[]): Invocation | undefined {
  let i = 0;
  let viaXargs = false;
  for (;;) {
    while (
      i < words.length &&
      (ASSIGNMENT.test(words[i] ?? '') || SHELL_KEYWORDS.has(words[i] ?? ''))
    )
      i++;
    const word = words[i];
    if (word === undefined) return undefined;
    const executable = executableName(word);
    const prefix = COMMAND_PREFIXES[executable];
    const rest = words.slice(i + 1);
    if (!prefix || (executable === 'env' && envCommandIsDump(rest)))
      return { executable, args: rest, viaXargs };
    if (executable === 'xargs') viaXargs = true;
    i++;
    let operands = prefix.operands ?? 0;
    while (i < words.length) {
      const arg = words[i] ?? '';
      if (executable === 'env' && /^(?:-S|--split-string)/.test(arg)) {
        const inline = arg.replace(/^(?:-S|--split-string=?)/, '');
        return {
          executable: 'env',
          args: [],
          viaXargs,
          script: [inline, ...words.slice(i + 1)].join(' '),
        };
      }
      // After `env`, a bare `-` is an option (`-i`), not a command.
      if (arg.startsWith('-') && (arg !== '-' || executable === 'env')) {
        i += takesValue(arg, prefix.values) ? 2 : 1;
        continue;
      }
      if (executable === 'env' && ASSIGNMENT.test(arg)) {
        i++;
        continue;
      }
      if (operands > 0) {
        operands--;
        i++;
        continue;
      }
      break;
    }
  }
}

/**
 * Distinctive stem of each sensitive name: a glob counts only when its literal characters carry
 * the stem of a name it can match, so `*.json` or `package*.json` names no sensitive file while
 * `auth*.json` does. `env` must stand as a name segment (`.env*`, not `environment*`).
 */
const ENV_STEM = /(?:^|[^a-z0-9])env(?:[^a-z0-9]|$)/;
const stem = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

const BASENAME_STEMS: Record<string, RegExp> = {
  '.env': ENV_STEM,
  '.envrc': stem('envrc'),
  '.flaskenv': stem('flask'),
  '.npmrc': stem('npm'),
  '.yarnrc': stem('yarn'),
  '.yarnrc.yml': stem('yarn'),
  '.pypirc': stem('pypi'),
  '.netrc': stem('netrc'),
  _netrc: stem('netrc'),
  '.pgpass': stem('pgpass'),
  '.my.cnf': stem('cnf'),
  '.git-credentials': stem('credential'),
  'auth.json': stem('auth'),
  credentials: stem('credential'),
  'credentials.json': stem('credential'),
  id_rsa: /id_|rsa/,
  id_dsa: /id_|dsa/,
  id_ecdsa: /id_|ecdsa/,
  id_ed25519: /id_|ed25519/,
  known_hosts: stem('known'),
  '.claude.json': stem('claude'),
  'secrets.json': stem('secret'),
  'secrets.yaml': stem('secret'),
  'secrets.yml': stem('secret'),
};

/**
 * Family globs for every sensitive name, one entry per path segment, each with its stem. They
 * mirror SENSITIVE_BASENAMES and SENSITIVE_PATTERNS, so a shell glob is checked against what the
 * patterns describe rather than against a literal name; keep them in step.
 */
const SENSITIVE_GLOBS: Array<{ segments: string[]; stem: RegExp }> = [
  ...[...SENSITIVE_BASENAMES].map((name) => ({
    segments: [name],
    stem: BASENAME_STEMS[name] ?? stem(name.replace(/^[._]/, '')),
  })),
  { segments: ['.env.*'], stem: ENV_STEM },
  ...['pem', 'key', 'p12', 'pfx', 'jks', 'keystore', 'asc', 'gpg', 'ppk', 'tfvars', 'tfstate'].map(
    (ext) => ({ segments: [`*.${ext}`], stem: stem(ext) }),
  ),
  ...(['rsa', 'dsa', 'ecdsa', 'ed25519'] as const).map((kind) => ({
    segments: [`id_${kind}.pub`],
    stem: new RegExp(`id_|${kind}`),
  })),
  { segments: ['.ssh', '*'], stem: stem('ssh') },
  { segments: ['.aws', '*'], stem: stem('aws') },
  { segments: ['.gnupg', '*'], stem: stem('gnupg') },
  { segments: ['.config', 'gcloud', '*'], stem: stem('gcloud') },
  { segments: ['.kube', 'config'], stem: stem('kube') },
  { segments: ['.docker', 'config.json'], stem: stem('docker') },
  { segments: ['service-account*.json'], stem: stem('service') },
  { segments: ['.claude', 'settings.json'], stem: stem('claude') },
  { segments: ['.claude', 'settings.local.json'], stem: stem('claude') },
  { segments: ['.codex', 'auth.json'], stem: stem('codex') },
  { segments: ['.codex', 'config.toml'], stem: stem('codex') },
  ...['yaml', 'yml', 'json', 'toml', 'env'].map((ext) => ({
    segments: [`*secret*.${ext}`],
    stem: stem('secret'),
  })),
];

type GlobToken =
  | { kind: 'star' }
  | { kind: 'any' }
  | { kind: 'char'; char: string }
  | { kind: 'set'; test: (char: string) => boolean; dot: boolean };

function globTokens(segment: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  const chars = [...segment];
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i] ?? '';
    if (char === '*') {
      if (tokens.at(-1)?.kind !== 'star') tokens.push({ kind: 'star' });
    } else if (char === '?') tokens.push({ kind: 'any' });
    else if (char === '[') {
      const close = chars.indexOf(']', i + 2);
      if (close < 0) {
        tokens.push({ kind: 'char', char });
        continue;
      }
      const body = chars.slice(i + 1, close);
      const negated = body[0] === '!' || body[0] === '^';
      const members = negated ? body.slice(1) : body;
      const inSet = (c: string) =>
        members.some(
          (m, k) =>
            m === c ||
            (members[k + 1] === '-' &&
              members[k + 2] !== undefined &&
              m <= c &&
              c <= (members[k + 2] ?? '')),
        );
      tokens.push({ kind: 'set', test: (c) => inSet(c) !== negated, dot: inSet('.') !== negated });
      i = close;
    } else tokens.push({ kind: 'char', char });
  }
  return tokens;
}

function tokensCompatible(x: GlobToken, y: GlobToken): boolean {
  if (x.kind === 'char' && y.kind === 'char') return x.char === y.char;
  if (x.kind === 'char' && y.kind === 'set') return y.test(x.char);
  if (y.kind === 'char' && x.kind === 'set') return x.test(y.char);
  return true;
}

/** Whether some name matches both globs. Two character classes are assumed to overlap. */
function globsIntersect(a: GlobToken[], b: GlobToken[]): boolean {
  // Cheap rejects first: two fixed ends must agree.
  const [a0, b0, an, bn] = [a[0], b[0], a.at(-1), b.at(-1)];
  if (a0 && b0 && a0.kind !== 'star' && b0.kind !== 'star' && !tokensCompatible(a0, b0))
    return false;
  if (an && bn && an.kind !== 'star' && bn.kind !== 'star' && !tokensCompatible(an, bn))
    return false;
  const width = b.length + 1;
  // 0 unknown, 1 true, 2 false.
  const memo = new Uint8Array((a.length + 1) * width);
  const go = (i: number, j: number): boolean => {
    const key = i * width + j;
    const cached = memo[key];
    if (cached) return cached === 1;
    const x = a[i];
    const y = b[j];
    let result: boolean;
    if (x === undefined && y === undefined) result = true;
    else if (x?.kind === 'star') result = go(i + 1, j) || (y !== undefined && go(i, j + 1));
    else if (y?.kind === 'star') result = go(i, j + 1) || (x !== undefined && go(i + 1, j));
    else if (x === undefined || y === undefined) result = false;
    else result = tokensCompatible(x, y) && go(i + 1, j + 1);
    memo[key] = result ? 1 : 2;
    return result;
  };
  return go(0, 0);
}

const allStars = (tokens: GlobToken[]) => tokens.every((t) => t.kind === 'star');

/**
 * Whether a user's glob segment can match a sensitive one. A leading dot is matched only by a
 * dot (the shell default), and a segment that is all `*` names everything rather than a sensitive
 * file, so it matches only a sensitive segment that is itself all `*` (`~/.ssh/*`), unless the
 * caller has already matched the directories above it literally (`~/.kube/*`).
 */
function segmentMatches(
  user: GlobToken[],
  family: GlobToken[],
  underLiteralDirs: boolean,
): boolean {
  if (allStars(user)) return allStars(family) || underLiteralDirs;
  const first = user[0];
  if (
    family[0]?.kind === 'char' &&
    family[0].char === '.' &&
    !(first?.kind === 'char' && first.char === '.') &&
    !(first?.kind === 'set' && first.dot)
  )
    return false;
  return globsIntersect(user, family);
}

const MAX_NAME_CHARS = 255;
const MAX_READER_OPERANDS = 1024;
const SENSITIVE_GLOB_TOKENS = SENSITIVE_GLOBS.map((family) => ({
  segments: family.segments.map(globTokens),
  /** Each segment's literal text, wildcards removed (`*.key` is `.key`). */
  literals: family.segments.map((segment) => segment.replace(/[*?]/g, '')),
  stem: family.stem,
}));

/** A glob's literal characters, a one-character class read as that character, wildcards as NUL. */
function globLiterals(glob: string): string {
  return glob.replace(/\[([^\]!^])\]/g, '$1').replace(/\[[^\]]*\]|[*?]/g, '\0');
}

/** `{a,b}` alternatives, innermost first and bounded; ranges are left as written. */
function braceExpansions(word: string): string[] {
  let out = [word];
  for (let round = 0; round < 8; round++) {
    let changed = false;
    out = out.flatMap((w) => {
      const match = /\{([^{}]*,[^{}]*)\}/.exec(w);
      if (!match) return [w];
      changed = true;
      return (
        match[1]
          ?.split(',')
          .map((alt) => w.slice(0, match.index) + alt + w.slice(match.index + match[0].length)) ?? [
          w,
        ]
      );
    });
    if (!changed || out.length > 64) break;
  }
  return out.slice(0, 64);
}

/**
 * Whether a glob that can match a sensitive name also carries enough of it to single it out:
 * the name's distinctive stem (`auth*.json`, `*.pem`); a leading dot against a dotfile or dot
 * directory (`.e*`, `.*`, a `.s*` directory), since dotfiles are globbed on purpose; or a literal run of
 * three or more characters that begins the name (`cred*`, `*.ke?`). `*.json` and `package*.json`
 * carry none of these.
 */
function carriesSensitiveName(
  userParts: string[],
  user: GlobToken[][],
  family: { literals: string[]; stem: RegExp },
): boolean {
  if (family.stem.test(globLiterals(userParts.join('/')))) return true;
  return user.some((tokens, k) => {
    const name = family.literals[k] ?? '';
    const first = tokens[0];
    if (name.startsWith('.') && first?.kind === 'char' && first.char === '.') return true;
    const runs = globLiterals(userParts[k] ?? '').split('\0');
    return runs.some((run) => run.length >= 3 && name.startsWith(run));
  });
}

/** Whether a shell glob (`.env*`, `*.pem`, `id_*`, `.env{,.local}`) can match a sensitive name. */
function globNamesSensitive(word: string): boolean {
  if (!/[*?[{]/.test(word)) return false;
  for (const expansion of braceExpansions(word)) {
    if (!/[*?[]/.test(expansion)) {
      if (isSensitiveSpelling(expansion, 'none')) return true;
      continue;
    }
    const parts = expansion
      .normalize('NFKC')
      .toLowerCase()
      .replace(/\\/g, '/')
      .split('/')
      .filter((s) => s !== '' && s !== '.');
    // No file name is longer than 255 characters; a longer pattern is not scanned.
    if (parts.some((part) => part.length > MAX_NAME_CHARS)) return true;
    const segments = parts.map(globTokens);
    for (const family of SENSITIVE_GLOB_TOKENS) {
      // Align the ends; a glob shorter than the family may name its directory (`.ss*`).
      const longEnough = segments.length >= family.segments.length;
      const user = longEnough ? segments.slice(-family.segments.length) : segments;
      const against = longEnough ? family.segments : family.segments.slice(0, segments.length);
      if (!user.length) continue;
      const userParts = longEnough ? parts.slice(-family.segments.length) : parts;
      // `~/.kube/*`: the directories match the family's literally, so `*` stands for its files.
      const literalDirs =
        user.length > 1 &&
        userParts.slice(0, -1).every((part, k) => part === family.literals[k]) &&
        family.segments.length === user.length;
      const matches = user.every((u, k) =>
        segmentMatches(u, against[k] ?? [], literalDirs && k === user.length - 1),
      );
      if (matches && carriesSensitiveName(userParts, user, family)) return true;
    }
  }
  return false;
}

/** A shell word naming a sensitive file: literally, as an `option=value`, or as a glob. */
function isSensitiveShellWord(word: string): boolean {
  const eq = word.indexOf('=');
  for (const candidate of eq > 0 ? [word, word.slice(eq + 1)] : [word]) {
    // A shell passes its words through undecoded, so a `%` here is literal (an awk or grep
    // pattern, often) and is not percent-decoded; the other normalizations still apply.
    if (isSensitiveSpelling(candidate, 'none') || globNamesSensitive(candidate)) return true;
  }
  return false;
}

/** As above, or a directory a recursive reader would descend into (`grep -r KEY ~/.aws`). */
function namesSensitiveFileOrTree(word: string): boolean {
  return isSensitiveShellWord(word) || isSensitiveSpelling(`${word}/_`, 'none');
}

/** Whether any of these words names a sensitive file or tree; too many count as sensitive. */
function anyNamesSensitive(words: Iterable<string>): boolean {
  const unique = new Set(words);
  // More operands than any real invocation names: counted as sensitive rather than scanned.
  if (unique.size > MAX_READER_OPERANDS) return true;
  for (const word of unique) if (namesSensitiveFileOrTree(word)) return true;
  return false;
}

/** Git options whose value is a pattern, a revision or a format, never a path to read. */
const GIT_SKIPPED_VALUES = new Set([
  '-S',
  '-G',
  '-e',
  '--grep',
  '--author',
  '--committer',
  '-n',
  '--max-count',
  '--skip',
  '--since',
  '--after',
  '--until',
  '--before',
  '--format',
  '--pretty',
  '--date',
  '-m',
  '--max-depth',
  '-O',
  '-U',
  '--unified',
  '--diff-filter',
]);

/**
 * Whether git prints a sensitive file: `git show HEAD:.env`, `git cat-file -p :.env`, a path
 * after `--`, `git log -L1,9:.env`, or a `git grep -f` pattern file. Pattern and revision options
 * (`-S`, `--grep`, `--author`) and `git grep`'s own pattern are never read as paths.
 */
function gitShowsSensitive(args: string[]): boolean {
  let i = 0;
  while (i < args.length && (args[i] ?? '').startsWith('-'))
    i += GIT_VALUE_OPTIONS.has(args[i] ?? '') ? 2 : 1;
  const subcommand = args[i] ?? '';
  if (!GIT_CONTENT_COMMANDS.has(subcommand)) return false;
  const named = (arg: string) => {
    const colon = arg.indexOf(':');
    return isSensitiveShellWord(arg) || (colon >= 0 && isSensitiveShellWord(arg.slice(colon + 1)));
  };
  const operands: string[] = [];
  let patternGiven = false;
  for (let k = i + 1; k < args.length; k++) {
    const arg = args[k] ?? '';
    if (arg === '--') return args.slice(k + 1).some(named) || false;
    if (!arg.startsWith('-') || arg === '-') {
      operands.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg : arg.slice(0, eq);
    const attached = eq < 0 && /^-[A-Za-z]./.test(arg) ? arg.slice(2) : undefined;
    if (name === '-L' || name.startsWith('-L')) {
      const value = eq >= 0 ? arg.slice(eq + 1) : attached || args[++k];
      if (value !== undefined && named(value)) return true;
      continue;
    }
    if (subcommand === 'grep' && (name === '-f' || name === '--file')) {
      patternGiven = true;
      const value = eq >= 0 ? arg.slice(eq + 1) : (attached ?? args[++k]);
      if (value !== undefined && named(value)) return true;
      continue;
    }
    if (subcommand === 'grep' && (name === '-e' || name === '--regexp')) patternGiven = true;
    if (eq < 0 && attached === undefined && GIT_SKIPPED_VALUES.has(name)) k++;
  }
  if (subcommand === 'grep' && !patternGiven) operands.shift();
  return operands.some(named);
}

/** `set`, `export`, `declare` and `typeset` print variables only when bare (or given `-p`). */
function printsVariables(args: string[]): boolean {
  return args.every((arg) => /^-[px]+$/.test(arg));
}

/**
 * The words a command passes on that may be file names for an `xargs` later in the pipeline:
 * a reader's files, and any other command's operands. Options and patterns are left out.
 */
function forwardedNames(segments: ShellSegment[]): string[] {
  const names: string[] = [];
  for (const segment of segments) {
    const call = invocation(segment.words);
    if (!call) continue;
    if (FILE_OUTPUT_COMMANDS.has(call.executable))
      names.push(...readerFiles(call.executable, call.args));
    else names.push(...call.args.filter((arg) => !arg.startsWith('-')));
  }
  return names;
}

function dumps(command: string, depth: number): boolean {
  if (depth > MAX_NESTED_SCRIPTS) return true;
  const { outer, inner } = substitutions(command);
  if (inner.some((script) => dumps(script, depth + 1))) return true;
  const segments = shellSegments(outer);
  // What an `xargs` reader may be fed, worked out once per command rather than per segment.
  let xargsFed: boolean | undefined;
  for (const segment of segments) {
    // Whatever reads a sensitive file on standard input can print it: `< .env cat`, `done < .env`.
    if (segment.inputs.some(isSensitiveShellWord)) return true;
    const call = invocation(segment.words);
    if (!call) continue;
    const { executable, args } = call;
    if (call.script !== undefined && dumps(call.script, depth + 1)) return true;
    if (ENV_OUTPUT_COMMANDS.has(executable)) return true;
    if (BARE_ENV_OUTPUT_COMMANDS.has(executable) && printsVariables(args)) return true;
    if (executable === 'env' && envCommandIsDump(args)) return true;
    if (SHELLS.has(executable)) {
      const flag = args.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a));
      if (flag >= 0 && dumps(args[flag + 1] ?? '', depth + 1)) return true;
    }
    if (executable === 'eval' && dumps(args.join(' '), depth + 1)) return true;
    if (executable === 'git' && gitShowsSensitive(args)) return true;
    if (executable === 'find') {
      const exec = args.findIndex((a) => /^-(?:exec|execdir|ok|okdir)$/.test(a));
      const run = exec >= 0 ? invocation(args.slice(exec + 1)) : undefined;
      if (run && FILE_OUTPUT_COMMANDS.has(run.executable) && anyNamesSensitive(args.slice(0, exec)))
        return true;
    }
    if (!FILE_OUTPUT_COMMANDS.has(executable)) continue;
    if (anyNamesSensitive(readerFiles(executable, args))) return true;
    // `xargs` takes file names from its input, so a name earlier in the pipeline may be one.
    if (call.viaXargs) {
      xargsFed ??= anyNamesSensitive(forwardedNames(segments));
      if (xargsFed) return true;
    }
  }
  return false;
}

/**
 * Whether a shell command prints a credential: an environment dump, or a file reader given a
 * sensitive file by name, glob, input redirection or `git show <rev>:<path>`, through prefixes
 * such as `sudo`, `xargs` or `bash -c`. Lexical only, and it prefers over-matching a sensitive
 * name to missing it.
 */
export function isCredentialDumpCommand(command: string): boolean {
  return dumps(command, 0);
}
