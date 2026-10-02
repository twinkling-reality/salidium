import { describe, expect, it } from 'vitest';
import { createRedactor } from './redactText.ts';
import { isCredentialDumpCommand, isSensitivePath } from './sensitivePaths.ts';

describe('redactor', () => {
  it('redacts vendor tokens keeping a type-identifying prefix and consistent numbering', () => {
    const r = createRedactor();
    const ghp = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`;
    const out = r.redact(`export GITHUB_TOKEN=${ghp}\ncurl -H "Authorization: Bearer ${ghp}"`);
    expect(out.text).not.toContain(ghp);
    expect(out.text).toContain('ghp_[GITHUB_TOKEN#1]');
    expect(out.text.match(/GITHUB_TOKEN#1/g)?.length).toBe(2);
    expect(out.text).not.toMatch(/a1B2c3D4/);
    expect(out.findings).toHaveLength(2);
    // Same secret later → same number; different secret → new number.
    const again = r.redact(`token ${ghp} and AKIAIOSFODNN7EXAMPLE`);
    expect(again.text).toContain('[GITHUB_TOKEN#1]');
    expect(again.text).toContain('AKIA[AWS_KEY#2]');
  });

  it('treats hex hashes as secrets when a credential keyword names them', () => {
    const r = createRedactor();
    const hex = 'e6b5c0f2f7fcb9de1aa2de57bf3fe03149d9582a8979d34aeb69ac184740ddbe';
    expect(r.redact(`Authorization: Bearer ${hex}`).text).toBe(
      'Authorization: Bearer [BEARER_TOKEN#1]',
    );
    expect(r.redact(`token=${hex}`).text).toBe('token=[SECRET#2]');
    // ...but a commit hash stays readable.
    expect(r.redact(`commit sha: ${hex.slice(0, 40)}`).findings).toHaveLength(0);
    // Generic secrets reveal nothing of the value.
    expect(r.redact('DB_PASSWORD=Xk9#mQ2v!Lp8Rt4wZa').text).toBe('DB_PASSWORD=[SECRET#3]');
  });

  it('redacts anthropic/openai/slack/stripe/jwt/private key/url passwords', () => {
    const r = createRedactor();
    const anth = `sk-ant-api03-${'x'.repeat(93)}AA`;
    const stripe = `sk_${'live'}_${'s'.repeat(24)}`;
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const pk = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nABC\n-----END RSA PRIVATE KEY-----';
    const text = `${anth} ${stripe} xoxb-123456789012-abcdefghijkl ${jwt}\n${pk}\npostgres://user:hunter2pass@localhost/db`;
    const out = r.redact(text);
    expect(out.text).toContain('[ANTHROPIC_KEY#');
    expect(out.text).toContain('[STRIPE_KEY#');
    expect(out.text).toContain('[SLACK_TOKEN#');
    expect(out.text).toContain('[JWT#');
    expect(out.text).toContain('[PRIVATE_KEY#');
    expect(out.text).toContain('[URL_PASSWORD#');
    expect(out.text).not.toContain('hunter2pass');
    expect(out.text).not.toContain('MIIEow');
  });

  it('applies the generic keyword rule conservatively', () => {
    const r = createRedactor();
    expect(r.redact('DATABASE_PASSWORD=Xk9#mQ2v!Lp8Rt4wZa').text).toContain('[SECRET#');
    // Placeholders, words, paths, versions, hashes are not secrets.
    for (const s of [
      'API_KEY=your-api-key',
      'password = changeme',
      'SECRET_PATH=/usr/local/bin',
      'token: 1.2.3',
      'secret=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      'const tokenizer = createTokenizer',
    ]) {
      expect(r.redact(s).findings).toHaveLength(0);
    }
  });

  it('leaves ordinary code and output untouched', () => {
    const r = createRedactor();
    const code =
      'export function add(a: number, b: number) { return a + b; }\n// see https://example.com/docs\nconst id = "550e8400-e29b-41d4-a716-446655440000";';
    expect(r.redact(code).text).toBe(code);
  });
});

describe('sensitive paths', () => {
  it('flags credential files and env dumps', () => {
    expect(isSensitivePath('/repo/.env')).toBe(true);
    expect(isSensitivePath('/repo/.env.local')).toBe(true);
    expect(isSensitivePath('/Users/x/.ssh/id_ed25519')).toBe(true);
    expect(isSensitivePath('/repo/certs/server.pem')).toBe(true);
    expect(isSensitivePath('/repo/src/env.ts')).toBe(false);
    expect(isSensitivePath('/repo/README.md')).toBe(false);
    expect(isCredentialDumpCommand('env | sort')).toBe(true);
    expect(isCredentialDumpCommand('env -0')).toBe(true);
    expect(isCredentialDumpCommand('env CUSTOM_FLAG=value')).toBe(true);
    expect(isCredentialDumpCommand('env CUSTOM_FLAG=value pnpm test')).toBe(false);
    expect(isCredentialDumpCommand('/usr/bin/printenv CUSTOM_TOKEN')).toBe(true);
    expect(isCredentialDumpCommand("sed -n '1p' '.env.local'")).toBe(true);
    expect(isCredentialDumpCommand("awk '{ print $1 }' ~/.npmrc")).toBe(true);
    expect(isCredentialDumpCommand('cat .env')).toBe(true);
    expect(isCredentialDumpCommand('echo cat .env')).toBe(false);
    expect(isCredentialDumpCommand('cat README.md')).toBe(false);
  });
});

/**
 * The terminator used to be a list of characters a secret was expected to be followed by. URL
 * query delimiters must terminate the match too.
 */
describe('token terminators', () => {
  const JWT =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

  it('redacts a token wherever it ends, not only where it was expected to', () => {
    const r = createRedactor();
    for (const text of [
      `https://x.test/cb?id_token=${JWT}&redirect=/home`,
      `https://x.test/#access_token=${JWT}#done`,
      `token: ${JWT}`,
      `"${JWT}"`,
      `<code>${JWT}</code>`,
    ]) {
      const out = r.redact(text);
      expect(out.findings.map((f) => f.ruleId)).toContain('jwt');
      expect(out.text).not.toContain('SflKxwRJ');
    }
  });

  it('still refuses to match a prefix of a longer token', () => {
    // The enumeration existed to stop that, and closing it by construction has to keep it.
    const r = createRedactor();
    const out = r.redact(`AIza${'b'.repeat(35)}${'c'.repeat(20)}`);
    expect(out.findings).toHaveLength(0);
  });

  it('leaves ordinary text alone', () => {
    const r = createRedactor();
    for (const text of [
      'commit 8bcac7903021d90e8bcac7903021d90e8bcac790',
      '/usr/local/lib/node_modules/whatever/index.js',
      'the quick brown fox jumped over it',
    ])
      expect(createRedactor().redact(text).findings).toHaveLength(0);
    expect(r).toBeDefined();
  });
});

/**
 * Agent transcripts and tool output are often JSON, YAML, HTTP, or environment files. The key rules
 * used to need the separator right after the key, so the closing quote of a JSON key hid every one.
 */
describe('credentials in structured text', () => {
  const redact = (text: string) => createRedactor().redact(text).text;

  it('redacts JSON values after quoted keys, and the document still parses', () => {
    for (const [text, expected] of [
      ['{"Authorization":"Bearer abc123"}', '{"Authorization":"Bearer [BEARER_TOKEN#1]"}'],
      ['{"api_key": "sk-abc123def456ghi789"}', '{"api_key": "[SECRET#1]"}'],
      ['{"password":"hunter2"}', '{"password":"[SECRET#1]"}'],
      ['{"X-Api-Key":"q8Zr2LmP0x"}', '{"X-Api-Key":"[BEARER_TOKEN#1]"}'],
      ['{ "client_secret" : "GOCSPX-4bX9qL2m" }', '{ "client_secret" : "[SECRET#1]" }'],
      [
        '{"headers":{"Authorization":["Bearer abc123"]}}',
        '{"headers":{"Authorization":["Bearer [BEARER_TOKEN#1]"]}}',
      ],
      [
        '{"aws_secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}',
        '{"aws_secret_access_key": "[AWS_SECRET#1]"}',
      ],
    ]) {
      expect(redact(text)).toBe(expected);
      expect(() => JSON.parse(redact(text))).not.toThrow();
    }
  });

  it('replaces a value with escaped quotes whole, so no tail leaks and JSON still parses', () => {
    const text = JSON.stringify({ password: 'hun"ter\\2x', user: 'bob' });
    expect(text).toBe('{"password":"hun\\"ter\\\\2x","user":"bob"}');
    const out = redact(text);
    expect(out).toBe('{"password":"[SECRET#1]","user":"bob"}');
    expect(JSON.parse(out)).toEqual({ password: '[SECRET#1]', user: 'bob' });
  });

  it('reads JSON inside a JSON string, as a raw provider record holds tool output', () => {
    const inner = JSON.stringify({ password: 'hun"ter2x', Authorization: 'Bearer abc123' });
    const record = JSON.stringify({ type: 'tool_result', content: inner });
    const out = redact(record);
    expect(out).not.toContain('hun');
    expect(out).not.toContain('abc123');
    expect(JSON.parse(JSON.parse(out).content)).toEqual({
      password: '[SECRET#1]',
      Authorization: 'Bearer [BEARER_TOKEN#2]',
    });
    // And an environment file read by a tool, one escaped line break in.
    expect(redact(JSON.stringify({ content: 'NODE_ENV=test\nDB_PASSWORD=hunter2\n' }))).toBe(
      '{"content":"NODE_ENV=test\\nDB_PASSWORD=[SECRET#1]\\n"}',
    );
  });

  it('redacts YAML, TOML, Python and PHP forms', () => {
    expect(redact('password: "hunter2"')).toBe('password: "[SECRET#1]"');
    expect(redact("password: 'hunter2'")).toBe("password: '[SECRET#1]'");
    expect(redact('  api_key: sk-abc123def456ghi789')).toBe('  api_key: [SECRET#1]');
    expect(redact('services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: hunter2')).toBe(
      'services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: [SECRET#1]',
    );
    expect(redact('password = "hunter2"')).toBe('password = "[SECRET#1]"');
    expect(redact("connect(user='bob', password='hunter2')")).toBe(
      "connect(user='bob', password='[SECRET#1]')",
    );
    expect(redact("config['password'] = 'hunter2'")).toBe("config['password'] = '[SECRET#1]'");
    expect(redact('os.environ["API_KEY"] = "hunter2x"')).toBe(
      'os.environ["API_KEY"] = "[SECRET#1]"',
    );
    expect(redact("'password' => 'hunter2',")).toBe("'password' => '[SECRET#1]',");
  });

  it('redacts HTTP headers in curl commands and logs', () => {
    expect(redact('curl -H "Authorization: Bearer abc123" https://api.test/v1')).toBe(
      'curl -H "Authorization: Bearer [BEARER_TOKEN#1]" https://api.test/v1',
    );
    expect(redact("curl -H 'X-Api-Key: q8Zr2LmP0x' https://api.test/v1")).toBe(
      "curl -H 'X-Api-Key: [BEARER_TOKEN#1]' https://api.test/v1",
    );
    expect(redact('> Authorization: Basic dXNlcjpwYXNz\n> Accept: */*')).toBe(
      '> Authorization: Basic [BEARER_TOKEN#1]\n> Accept: */*',
    );
    expect(redact('Proxy-Authorization: Basic dXNlcjpwYXNzd29yZDE=')).toBe(
      'Proxy-Authorization: Basic [BEARER_TOKEN#1]',
    );
    expect(redact('X-Auth-Token: 7f3k9q2m1z')).toBe('X-Auth-Token: [BEARER_TOKEN#1]');
    expect(redact('PRIVATE-TOKEN: q8Zr2LmP0x')).toBe('PRIVATE-TOKEN: [BEARER_TOKEN#1]');
  });

  it('redacts environment forms', () => {
    expect(redact('DB_PASSWORD=hunter2')).toBe('DB_PASSWORD=[SECRET#1]');
    expect(redact('export API_TOKEN="hunter2"')).toBe('export API_TOKEN="[SECRET#1]"');
    expect(redact('STRIPE_SECRET_KEY=whsec9f8e7d6c')).toBe('STRIPE_SECRET_KEY=[SECRET#1]');
    expect(redact('GITHUB_TOKEN=q8Zr2LmP0x pnpm release')).toBe(
      'GITHUB_TOKEN=[SECRET#1] pnpm release',
    );
  });

  it('gives a repeated secret one placeholder whatever form it is written in', () => {
    const r = createRedactor();
    const nested = JSON.stringify({ content: JSON.stringify({ password: 'hun"ter2x' }) });
    const out = [
      '{"password":"hun\\"ter2x"}',
      'PASSWORD="hun\\"ter2x"',
      nested,
      '{"Authorization":"Bearer abc123"}',
      'curl -H "Authorization: Bearer abc123"',
      '{"password":"another1"}',
    ].map((text) => r.redact(text).text);
    expect(out[0]).toContain('[SECRET#1]');
    expect(out[1]).toContain('[SECRET#1]');
    expect(out[2]).toContain('[SECRET#1]');
    expect(out[3]).toContain('[BEARER_TOKEN#2]');
    expect(out[4]).toContain('[BEARER_TOKEN#2]');
    expect(out[5]).toContain('[SECRET#3]');
  });

  it('redacts a value whose closing quote was clipped off', () => {
    expect(redact('{"api_key": "sk-abc123def4')).toBe('{"api_key": "[SECRET#1]');
    expect(redact('{"Authorization": "Bearer abc123def')).toBe(
      '{"Authorization": "Bearer [BEARER_TOKEN#1]',
    );
  });

  it('leaves its own placeholders alone, because text that crosses the boundary is redacted twice', () => {
    const once = redact(
      '{"password":"hunter2","token":"ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8","Authorization":"Bearer abc123"} DB_PASSWORD=hunter2',
    );
    expect(createRedactor().redact(once).findings).toHaveLength(0);
    // A placeholder the sync outbox has stripped of its number is still one.
    expect(createRedactor().redact('{"password":"[SECRET]"}').findings).toHaveLength(0);
  });

  it('leaves a private key in JSON to the private key rule, and its id to the generic one', () => {
    const out = redact(
      JSON.stringify({
        private_key_id: '3f9a2c1d8e7b6a5f4c3d2e1f0a9b8c7d6e5f4a3b',
        private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----\n',
      }),
    );
    expect(out).toBe('{"private_key_id":"[SECRET#1]","private_key":"[PRIVATE_KEY#2]\\n"}');
  });

  it('does not take prose, code, or non-secret JSON values for credentials', () => {
    for (const text of [
      // The word in a sentence.
      'Enter your password: it must be at least 8 characters',
      'the password is hunter2',
      'Authorization: required for every call to this endpoint',
      'Use an Authorization: Bearer token for each request',
      // Code that names credentials.
      'const token = getToken(user1)',
      'function getToken() { return cache.token }',
      'password = user.password2',
      'const tokenizer = createTokenizer(options)',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a template is the input under test.
      'headers: { Authorization: `Bearer ${this.token}` }',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a template is the input under test.
      '{"Authorization": "Bearer ${token}"}',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a template is the input under test.
      'GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
      'API_TOKEN=$API_TOKEN pnpm release',
      // JSON keys with empty or plainly non-secret values.
      '{"password": ""}',
      '{"password": null, "token": false}',
      '{"password": "Password", "passwordHint": "Must be at least 8 characters"}',
      '{"token": "Use the refresh token here"}',
      '{"max_tokens": 4096, "input_tokens": 1234, "cache_read_input_tokens": 98765}',
      '{"token_type": "Bearer", "secretName": "tls-cert-2024"}',
      '{"password": {"type": "string", "minLength": 8}}',
      '{"password": "********", "api_key": "<your-api-key>", "secret": "REDACTED"}',
      '{"authorization_url": "https://x.test/oauth/authorize"}',
      '{"api_key": "sk-...", "token": "xxxxxxxx"}',
      'password_reset_token_expiry = 3600',
      'MAX_TOKEN=4096',
    ]) {
      expect(createRedactor().redact(text).findings, text).toHaveLength(0);
    }
  });
});
