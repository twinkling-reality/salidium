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
  /(^|\/)[\w.-]*secret[\w.-]*\.(ya?ml|json|toml|env)$/i,
];

export function isSensitivePath(path: string): boolean {
  const norm = path.replace(/\\/g, '/');
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  if (SENSITIVE_BASENAMES.has(base)) return true;
  return SENSITIVE_PATTERNS.some((p) => p.test(norm));
}

type McpInput = Extract<ToolInput, { kind: 'mcp' }>;

const MCP_FILE_READ_TOOLS = new Set([
  'read_file',
  'read_text_file',
  'read_multiple_files',
  'get_file_contents',
  'get_contents',
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
    // fields only; scanning all strings would suppress unrelated database/browser MCP evidence.
    const fields =
      /["'](?:path|paths|file|files|file_?path|file_?paths|uri|uris)["']\s*:\s*["']([^"']+)["']/gi;
    for (const match of args.matchAll(fields)) {
      if (match[1] && isSensitivePath(match[1])) return true;
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

/** Minimal shell tokenization for command-aware output suppression, without executing input. */
function shellSegments(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = '';
  let quote: "'" | '"' | undefined;
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
  for (const char of command) {
    if (escaped) {
      word += char;
      escaped = false;
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
    if (FILE_OUTPUT_COMMANDS.has(executable) && args.some(isSensitivePath)) return true;
  }
  return false;
}
