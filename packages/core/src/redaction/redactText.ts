/**
 * Deterministic, zero-network secret redaction. Seeded from gitleaks' high-signal vendor rules
 * (regexes normalized for JS) plus a conservative keyword+value+entropy rule. Applied at ingest
 * to everything Salidium persists or broadcasts. Redacts spans only, keeps a type-identifying
 * prefix and a short tail so a reader still understands *what* was there, and numbers repeated
 * secrets consistently within a session so co-reference survives.
 */

export interface RedactionFinding {
  ruleId: string;
  start: number;
  end: number;
}

export interface RedactionResult {
  text: string;
  findings: RedactionFinding[];
}

interface Rule {
  id: string;
  label: string;
  pattern: RegExp;
  /** Capture group index holding the secret; 0 = whole match. */
  group: number;
  entropy?: number;
  keywords: string[];
  /**
   * Reads the value after a credential key instead of taking a capture group: `pattern` then
   * matches only the key and its separator, and the value is scanned by `keyedValue`.
   */
  keyed?: 'header' | 'generic';
}

/** A secret found in the text: the span replaced, and the value it is numbered and judged by. */
interface Candidate {
  start: number;
  end: number;
  secret: string;
  entropy?: number;
  /** The value proved itself a credential, so no allowlist or entropy bar applies. */
  certain?: boolean;
}

/**
 * A token ends where token characters stop.
 *
 * This was a list of the characters a secret was expected to be followed by — a quote, a bracket,
 * whitespace, an escaped newline, end of input. A URL query string is none of those: measured over
 * the author's store, all 13 JWTs that reached the database sat in one, every single one of them
 * followed by `&`, and the rule that exists to catch exactly that never fired. Enumerating the
 * terminators means every delimiter nobody thought of is a hole.
 *
 * Stated the other way round it is closed by construction, and still does the job the enumeration
 * was for: refusing to match a prefix of a longer token.
 */
const TERM = '(?![A-Za-z0-9._~+/=-])';

/**
 * Where a credential key may begin: the start of the text, whitespace, a quote, an opening bracket,
 * a list separator, or an escaped line break or tab, because a raw provider record carries tool
 * output as a JSON string and each of its lines starts after a literal `\n`.
 */
const KEY_START = String.raw`(?<=^|[\s"'${'`'}{(\[,;]|\\[nrt])`;
/**
 * A header name starts where a name starts: after anything that cannot be part of one, or after an
 * escaped line break or tab. It may carry a prefix (`HTTP_AUTHORIZATION`, `X-Authorization`,
 * `requestAuthorization`), because the header rule never had a left anchor. Allowing a prefix but
 * no start inside a name keeps the match linear: each name has one start, from which the prefix is
 * read once. A boundary that let every `-` or `_` start a match made it quadratic.
 */
const HEADER_START = String.raw`(?:(?<![\w.-])|(?<=\\[nrt]))`;

/**
 * A key, bare or quoted, then its separator. The quote may be escaped to any depth, since a JSON
 * document inside a JSON string writes `\"key\"`, and must close the way it opened. Groups: 1 the
 * quote's backslashes, 2 the quote, 3 the key name, 4 the separator with its whitespace.
 */
function keyPattern(start: string, name: string): RegExp {
  return new RegExp(
    String.raw`${start}(?:(\\*)(["'${'`'}]))?(${name})\1\2\]?(\s*(?:=>|:=|=|:)\s*)`,
    'gi',
  );
}

/** Words that make a key a credential's. A key that ends in one names the credential itself. */
const CREDENTIAL_WORD =
  'passw(?:or)?d|secret(?:[_-]?key)?|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token';
const NAMES_CREDENTIAL = new RegExp(`(?:${CREDENTIAL_WORD})$`, 'i');
/** An environment variable's name, as in `.env` files, `export`, and compose `environment:` maps. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
/** Header names whose value is a credential. `Authorization` alone may also carry a scheme. */
const CREDENTIAL_HEADER =
  '(?:proxy-)?authorization|x-api-key|api-key|x-auth-token|x-access-token|private-token|x-goog-api-key';
const AUTH_SCHEME = /^(?:bearer|token|basic)\s+/i;
/** The characters of an unquoted value, as each rule has always read them. */
const HEADER_VALUE = /[A-Za-z0-9._~+/=-]*/y;
const GENERIC_VALUE = /[A-Za-z0-9_+/=.~!#$%^&*-]*/y;
/**
 * An environment variable's unquoted value runs to whitespace, so `@` or `?` in a password does not
 * cut it short. It stops at a quote or backslash, which in a raw record ends or escapes the JSON
 * string around it, at shell punctuation that ends a word, and at the `,`, `}` or unopened `]`
 * that ends a pair in a list or an object. A bracketed part is read whole, so one of our own
 * placeholders is read as one.
 */
const ENV_VALUE = /(?:[^\s"'`\\;|()<>,}[\]]|\[[^\s"'`\\[\]]*\])*/y;
/** A placeholder already in the text, whose number a fresh redactor must not hand out again. */
const PLACEHOLDER_NUMBER = /\[[A-Z_]+#(\d+)\]/g;

const RULES: Rule[] = [
  {
    id: 'aws-access-key',
    label: 'AWS_KEY',
    pattern: /\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\b/g,
    group: 1,
    entropy: 3,
    keywords: ['akia', 'asia', 'abia', 'acca', 'a3t'],
  },
  {
    id: 'aws-secret-key',
    label: 'AWS_SECRET',
    pattern:
      /(?:aws|secret)[\w.-]{0,24}?(?:secret|access)[\w.-]{0,16}?(?:\\*['"])?\s*[:=]\s*(?:\\*['"])?([A-Za-z0-9/+=]{40})\b/gi,
    group: 1,
    entropy: 3.5,
    keywords: ['aws', 'secret'],
  },
  {
    id: 'github-token',
    label: 'GITHUB_TOKEN',
    pattern: /\b((?:ghp|gho|ghu|ghs|ghr)_[0-9a-zA-Z_]{20,255}|github_pat_[0-9a-zA-Z_]{22,255})\b/g,
    group: 1,
    keywords: ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_'],
  },
  {
    id: 'gitlab-token',
    label: 'GITLAB_TOKEN',
    pattern: /\b(glpat-[0-9a-zA-Z_-]{20,300})\b/g,
    group: 1,
    keywords: ['glpat-'],
  },
  {
    id: 'openai-key',
    label: 'OPENAI_KEY',
    pattern: new RegExp(
      String.raw`\b(sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})${TERM}`,
      'g',
    ),
    group: 1,
    keywords: ['t3blbkfj'],
  },
  {
    id: 'anthropic-key',
    label: 'ANTHROPIC_KEY',
    pattern: new RegExp(String.raw`\b(sk-ant-(?:api|admin)\d{2}-[a-zA-Z0-9_-]{80,}AA)${TERM}`, 'g'),
    group: 1,
    keywords: ['sk-ant-'],
  },
  {
    id: 'slack-token',
    label: 'SLACK_TOKEN',
    pattern: /\b(xox[abpers]-[0-9]{8,13}-[0-9A-Za-z-]{8,})\b/g,
    group: 1,
    keywords: ['xox'],
  },
  {
    id: 'slack-webhook',
    label: 'SLACK_WEBHOOK',
    pattern: /(https?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{20,})/g,
    group: 1,
    keywords: ['hooks.slack.com'],
  },
  {
    id: 'stripe-key',
    label: 'STRIPE_KEY',
    pattern: new RegExp(
      String.raw`\b((?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99})${TERM}`,
      'g',
    ),
    group: 1,
    keywords: ['sk_test', 'sk_live', 'sk_prod', 'rk_test', 'rk_live', 'rk_prod'],
  },
  {
    id: 'google-api-key',
    label: 'GOOGLE_KEY',
    pattern: new RegExp(String.raw`\b(AIza[\w-]{35})${TERM}`, 'g'),
    group: 1,
    entropy: 4,
    keywords: ['aiza'],
  },
  {
    id: 'npm-token',
    label: 'NPM_TOKEN',
    pattern: new RegExp(String.raw`\b(npm_[a-zA-Z0-9]{36})${TERM}`, 'g'),
    group: 1,
    keywords: ['npm_'],
  },
  {
    id: 'pypi-token',
    label: 'PYPI_TOKEN',
    pattern: /\b(pypi-AgEIcHlwaS5vcmc[\w-]{50,1000})\b/g,
    group: 1,
    keywords: ['pypi-ageicHlwas5vcmc'.toLowerCase()],
  },
  {
    id: 'huggingface-token',
    label: 'HF_TOKEN',
    pattern: new RegExp(String.raw`\b(hf_[a-zA-Z]{34})${TERM}`, 'g'),
    group: 1,
    keywords: ['hf_'],
  },
  {
    id: 'sendgrid-key',
    label: 'SENDGRID_KEY',
    pattern: new RegExp(String.raw`\b(SG\.[a-zA-Z0-9=_.-]{66})${TERM}`, 'g'),
    group: 1,
    keywords: ['sg.'],
  },
  {
    id: 'digitalocean-token',
    label: 'DO_TOKEN',
    pattern: /\b(dop_v1_[a-f0-9]{64})\b/g,
    group: 1,
    keywords: ['dop_v1_'],
  },
  {
    id: 'vault-token',
    label: 'VAULT_TOKEN',
    pattern: /\b(hvs\.[\w-]{90,120})\b/g,
    group: 1,
    keywords: ['hvs.'],
  },
  {
    id: 'jwt',
    label: 'JWT',
    pattern: new RegExp(
      String.raw`\b(ey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9/\\_-]{17,}\.[a-zA-Z0-9/\\_-]{10,}={0,2})${TERM}`,
      'g',
    ),
    group: 1,
    entropy: 3,
    keywords: ['ey'],
  },
  {
    id: 'private-key',
    label: 'PRIVATE_KEY',
    pattern:
      /(-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,4000}?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----)/g,
    group: 1,
    keywords: ['-----begin'],
  },
  {
    id: 'bearer-header',
    label: 'BEARER_TOKEN',
    pattern: keyPattern(HEADER_START, String.raw`[\w.-]*?(?:${CREDENTIAL_HEADER})`),
    group: 0,
    keywords: ['authorization', 'api-key', '-token'],
    keyed: 'header',
  },
  {
    id: 'url-credentials',
    label: 'URL_PASSWORD',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:([^@\s/]{3,})@/gi,
    group: 1,
    keywords: ['://'],
  },
  {
    id: 'generic-secret',
    label: 'SECRET',
    pattern: keyPattern(KEY_START, String.raw`[\w.-]{0,30}?(?:${CREDENTIAL_WORD})[\w.-]{0,10}`),
    group: 0,
    keywords: [
      'passw',
      'secret',
      'token',
      'api_key',
      'api-key',
      'apikey',
      'access_key',
      'access-key',
      'accesskey',
      'private_key',
      'private-key',
      'privatekey',
    ],
    keyed: 'generic',
  },
];

const ALLOW_VALUE = [
  /^(true|false|null|none|undefined|changeme|example|placeholder|your[_-]?(api[_-]?)?key|xxx+|<[^>]+>|\$\{?[A-Z_]+\}?|%[A-Z_]+%)$/i,
  /^[a-zA-Z_.-]+$/, // words only, no digits: not a secret
  /^\/|^\.\.?\//, // paths
  /^https?:\/\//i,
  /^\d+(\.\d+){1,3}$/, // versions / ips
  /^[0-9a-f-]{36}$/i, // uuids
  /^(?:\*+|•+|\[?redacted\]?|<redacted>)$/i, // already masked
  /^[\w.-]*\[[A-Z_]+(?:#\d+)?\]$/, // a placeholder of ours: text that crosses is redacted twice
  /^(?:\$\{[^}]*\}|\{\{[^}]*\}\}|\{\w[\w.]*\})$/, // a template that is filled in later
];
/** Bare 40/64-hex values are usually git SHAs or content hashes — unless the surrounding keyword says otherwise. */
const HEX_HASH = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;
const HASH_KEYWORD = /\b(sha|hash|commit|digest|checksum|integrity|rev|revision|blob|tree|oid)\b/i;

export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Where the content of a quoted value ends, or -1 when a line break or the end of the text comes
 * first.
 *
 * The opening delimiter was `depth` backslashes and a quote: 0 in a JSON or YAML document, 1 in a
 * JSON document inside a JSON string, 3 one level further in. At that depth an escaped quote in
 * the value, or any quote of a string nested deeper, is preceded by 2 * depth + 1 backslashes
 * modulo 2 * depth + 2, and the closing quote by `depth`. Any other count belongs to a string
 * this one sits inside, which ended first, so the value has no end here. The scan stops at the
 * next quote of its own kind, so keys that each open a value cannot make it quadratic.
 */
function quotedValueEnd(text: string, from: number, quote: string, depth: number): number {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' && quote !== '"' && closesJsonString(text, i + 1)) return -1;
    if (c === '\\') {
      let j = i;
      while (text[j] === '\\') j++;
      if (text[j] === '"' && quote !== '"' && closesJsonString(text, j + 1)) return -1;
      if (text[j] === quote) {
        const run = (j - i) % (2 * depth + 2);
        if (run === depth) return j - depth;
        if (run !== 2 * depth + 1) return -1;
        i = j + 1;
      } else i = j;
      continue;
    }
    if (c === quote) return depth === 0 ? i : -1;
    if ((c === '\n' || c === '\r') && quote !== '`') return -1;
    i++;
  }
  return -1;
}

/**
 * Inside a raw record, a single-quoted or backtick value sits inside a JSON string, and a double
 * quote followed by JSON punctuation ends that string; reading past it would redact across a JSON
 * boundary. Any other double quote is part of the value, as in `PGPASSWORD='ab"cd'`.
 */
function closesJsonString(text: string, after: number): boolean {
  let i = after;
  while (text[i] === ' ') i++;
  return i >= text.length || /[,:}\]]/.test(text[i] ?? '');
}

/**
 * Basic credentials are `user:password` in base64, which may be all letters and so pass for a word.
 * Decoding them settles it.
 */
function isBasicCredential(value: string): boolean {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    return /^[\x20-\x7e]+:[\x20-\x7e]*$/.test(atob(value));
  } catch {
    return false;
  }
}

const ESCAPED: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };

/**
 * The value a reader means, with one level of JSON escaping removed for each level the delimiter
 * had, so a secret is numbered the same however deeply it was quoted.
 */
function unescapeValue(raw: string, depth: number): string {
  let value = raw;
  for (let level = depth + 1; level >= 1; level /= 2)
    value = value.replace(/\\(u[0-9a-fA-F]{4}|.)/gs, (_, c: string) =>
      c.length === 5 ? String.fromCharCode(Number.parseInt(c.slice(1), 16)) : (ESCAPED[c] ?? c),
    );
  return value;
}

/**
 * Reads the value after a credential key and decides how much evidence it needs.
 *
 * A key that names a credential (`password`, `"api_key"`, `DB_TOKEN`) with a quoted value, or an
 * environment variable's name, is evidence enough for a short value: six characters that are not
 * a word, a placeholder, or a template. So is a header that names a credential or an
 * `Authorization` value with a scheme. Everything else keeps the original bar: an unquoted value
 * after a key that merely mentions a credential (`tokenizer = ...`) needs twelve characters and
 * real entropy, and a bare `Authorization:` value sixteen.
 *
 * A quoted value is read to its closing quote, escapes included, and replaced whole, so the
 * placeholder never splits an escape and a redacted JSON document still parses. A quoted value
 * with whitespace in it is usually prose, so only its leading run is read, at the original bar,
 * as the rules always did. So is a quote that never closes, as in a clipped excerpt.
 */
function keyedValue(
  text: string,
  from: number,
  key: RegExpExecArray,
  kind: 'header' | 'generic',
): Candidate | undefined {
  let i = from;
  // A list of one quoted value, as `{"Authorization": ["Bearer ..."]}` in a Go header map.
  const listed = /^\[ *\\*["'`]/.exec(text.slice(i, i + 64));
  if (listed) i += listed[0].replace(/\\*["'`]$/, '').length;
  let depth = 0;
  while (text[i + depth] === '\\') depth++;
  const quote = text[i + depth];
  const quoted = quote === '"' || quote === "'" || quote === '`';
  if (!quoted && depth > 0) return undefined;
  const start = quoted ? i + depth + 1 : i;
  const end = quoted ? quotedValueEnd(text, start, quote, depth) : -1;
  let raw = end >= 0 ? text.slice(start, end) : undefined;
  let weak = false;
  const name = key[3] ?? '';

  if (kind === 'header') {
    let scheme = raw === undefined ? '' : (AUTH_SCHEME.exec(raw)?.[0] ?? '');
    let secretStart = start + scheme.length;
    let secretRaw = raw?.slice(scheme.length);
    if (secretRaw !== undefined && /\s/.test(secretRaw)) {
      secretRaw = undefined;
      weak = true;
    }
    if (secretRaw === undefined) {
      scheme = AUTH_SCHEME.exec(text.slice(start, start + 16))?.[0] ?? '';
      secretStart = start + scheme.length;
      // `Authorization: Bearer "..."` quotes the credential rather than the whole value.
      if (scheme && /['"]/.test(text[secretStart] ?? '')) secretStart++;
      HEADER_VALUE.lastIndex = secretStart;
      secretRaw = HEADER_VALUE.exec(text)?.[0] ?? '';
      depth = 0;
    }
    const named = !weak && (scheme !== '' || !/authorization$/i.test(name));
    const secret = unescapeValue(secretRaw, depth);
    if (secret.length < (named ? 6 : 16)) return undefined;
    return {
      start: secretStart,
      end: secretStart + secretRaw.length,
      secret,
      entropy: named ? 2 : 3,
      certain: /^basic/i.test(scheme) && isBasicCredential(secret),
    };
  }

  if (raw !== undefined && /\s/.test(raw)) {
    raw = undefined;
    weak = true;
  }
  const envStyle = key[2] === undefined && ENV_NAME.test(name) && /^\s*[:=]/.test(key[4] ?? '');
  const strong = !weak && NAMES_CREDENTIAL.test(name) && (quoted || envStyle);
  if (raw === undefined) {
    const unquoted = envStyle && !quoted ? ENV_VALUE : GENERIC_VALUE;
    unquoted.lastIndex = start;
    raw = unquoted.exec(text)?.[0] ?? '';
    depth = 0;
  }
  const secret = unescapeValue(raw, depth);
  if (secret.length < (strong ? 6 : 12)) return undefined;
  return { start, end: start + raw.length, secret, entropy: strong ? 2 : 3.5 };
}

export interface Redactor {
  redact(text: string): RedactionResult;
  readonly findingsCount: number;
}

/**
 * Creates a redactor whose placeholder numbering is stable per session: the same secret text
 * always maps to the same label number, without storing the plaintext.
 */
export function createRedactor(): Redactor {
  const labels = new Map<string, number>();
  let counter = 0;
  let findingsCount = 0;
  const numberFor = (label: string, secret: string): number => {
    const key = `${label} ${fnv1a(secret)}`;
    let n = labels.get(key);
    if (n === undefined) {
      n = ++counter;
      labels.set(key, n);
    }
    return n;
  };
  return {
    get findingsCount() {
      return findingsCount;
    },
    redact(text: string): RedactionResult {
      if (!text) return { text, findings: [] };
      const lower = text.toLowerCase();
      const spans: Array<{
        start: number;
        end: number;
        ruleId: string;
        label: string;
        secret: string;
      }> = [];
      for (const rule of RULES) {
        if (!rule.keywords.some((k) => lower.includes(k))) continue;
        rule.pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic global-regex iteration
        while ((m = rule.pattern.exec(text)) !== null) {
          if (m[0].length === 0) rule.pattern.lastIndex++;
          let found: Candidate | undefined;
          if (rule.keyed) {
            found = keyedValue(text, m.index + m[0].length, m, rule.keyed);
            if (found) rule.pattern.lastIndex = Math.max(rule.pattern.lastIndex, found.end);
          } else {
            const value = m[rule.group] ?? m[0];
            const start = m.index + m[0].indexOf(value);
            if (value) found = { start, end: start + value.length, secret: value };
          }
          if (!found) continue;
          const { start, end, secret } = found;
          if (found.certain) {
            // Proven by its content; the bars below are for values that are only probably secrets.
          } else if (
            rule.id === 'generic-secret' ||
            rule.id === 'bearer-header' ||
            rule.id === 'aws-secret-key' ||
            rule.id === 'url-credentials'
          ) {
            if (ALLOW_VALUE.some((a) => a.test(secret))) continue;
            // A hex hash is allowed only for the generic rule when the context talks about hashes;
            // "token=<64 hex>" or "Authorization: Bearer <64 hex>" is a credential.
            if (HEX_HASH.test(secret)) {
              const context = text.slice(
                Math.max(0, m.index - 40),
                Math.max(end, m.index + m[0].length),
              );
              if (rule.id === 'generic-secret' && HASH_KEYWORD.test(context)) continue;
              if (
                rule.id !== 'generic-secret' &&
                rule.id !== 'bearer-header' &&
                rule.id !== 'url-credentials'
              )
                continue;
            }
          }
          const entropy = found.certain ? undefined : (found.entropy ?? rule.entropy);
          if (entropy !== undefined && shannonEntropy(secret) < entropy) continue;
          spans.push({ start, end, ruleId: rule.id, label: rule.label, secret });
        }
      }
      if (spans.length === 0) return { text, findings: [] };
      // Text redacted at ingest is redacted again where it crosses a boundary, by a fresh redactor.
      // A number already in the text is taken, or two different secrets would share a placeholder.
      if (text.includes('#'))
        for (const placeholder of text.matchAll(PLACEHOLDER_NUMBER))
          counter = Math.max(counter, Number(placeholder[1]));
      spans.sort((a, b) => a.start - b.start || b.end - a.end);
      const merged: typeof spans = [];
      for (const s of spans) {
        const last = merged[merged.length - 1];
        if (last && s.start < last.end) continue; // overlapping: keep the earlier/longer
        merged.push(s);
      }
      let out = '';
      let cursor = 0;
      const findings: RedactionFinding[] = [];
      for (const s of merged) {
        out += text.slice(cursor, s.start);
        const n = numberFor(s.label, s.secret);
        const placeholder = placeholderFor(s.secret, s.label, n, s.ruleId);
        findings.push({
          ruleId: s.ruleId,
          start: out.length,
          end: out.length + placeholder.length,
        });
        out += placeholder;
        cursor = s.end;
      }
      out += text.slice(cursor);
      findingsCount += findings.length;
      return { text: out, findings };
    },
  };
}

/** Vendor tokens whose prefix is a fixed public literal; only that literal is preserved. */
const LITERAL_PREFIX: Record<string, RegExp> = {
  'aws-access-key': /^(A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)/,
  'github-token': /^(gh[posur]_|github_pat_)/,
  'gitlab-token': /^glpat-/,
  'openai-key': /^sk-(?:proj-|svcacct-|admin-)?/,
  'anthropic-key': /^sk-ant-(?:api|admin)\d{2}-/,
  'slack-token': /^xox[abpers]-/,
  'slack-webhook': /^https?:\/\/hooks\.slack\.com\//,
  'stripe-key': /^(sk|rk)_(test|live|prod)_/,
  'google-api-key': /^AIza/,
  'npm-token': /^npm_/,
  'pypi-token': /^pypi-/,
  'huggingface-token': /^hf_/,
  'sendgrid-key': /^SG\./,
  'digitalocean-token': /^dop_v1_/,
  'vault-token': /^hvs\./,
};

/**
 * Only the type-identifying literal prefix of a vendor token survives; generic secrets, bearer
 * tokens, URL passwords, JWTs and AWS secret keys reveal nothing at all.
 */
function placeholderFor(secret: string, label: string, n: number, ruleId: string): string {
  const literal = LITERAL_PREFIX[ruleId]?.exec(secret)?.[0];
  return literal ? `${literal}[${label}#${n}]` : `[${label}#${n}]`;
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

export const REDACTION_RULE_IDS = RULES.map((r) => r.id);
