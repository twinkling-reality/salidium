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
