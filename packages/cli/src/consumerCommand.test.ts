import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONSUMER_TOKEN_PATTERN } from '@salidium/consumer-contract';
import { ConsumerCredentialVerifier, consumerCredentialPath } from '@salidium/daemon';
import { afterEach, describe, expect, it } from 'vitest';
import { runConsumerCommand } from './consumerCommand.ts';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function run(home: string, sub: string | undefined, args: string[] = [], json = false) {
  let out = '';
  let err = '';
  const code = runConsumerCommand(
    home,
    sub,
    args,
    { json },
    { out: (text) => (out += text), err: (text) => (err += text) },
  );
  return { code, out, err };
}

describe('salidium consumer', () => {
  it('creates a credential, shows it once, lists it without the secret, and revokes it', () => {
    const home = mkdtempSync(join(tmpdir(), 'salidium-consumer-cli-'));
    homes.push(home);
    const created = run(home, 'create', ['my', 'launcher'], true);
    expect(created.code).toBe(0);
    const { credential, token } = JSON.parse(created.out) as {
      credential: { id: string; label: string };
      token: string;
    };
    expect(credential.label).toBe('my launcher');
    expect(token).toMatch(CONSUMER_TOKEN_PATTERN);
    expect(statSync(consumerCredentialPath(home)).mode & 0o077).toBe(0);

    const verifier = new ConsumerCredentialVerifier(home);
    expect(verifier.verify(token)?.id).toBe(credential.id);

    const listed = run(home, 'list');
    expect(listed.out).toContain(credential.id);
    expect(listed.out).toContain('my launcher');
    expect(listed.out).not.toContain(token.slice(-64));

    expect(run(home, 'revoke', [credential.id]).code).toBe(0);
    expect(verifier.verify(token)).toBeUndefined();
    expect(run(home, 'revoke', [credential.id]).code).toBe(1);
  });

  it('refuses a missing or unprintable label, and an unknown subcommand', () => {
    const home = mkdtempSync(join(tmpdir(), 'salidium-consumer-cli-'));
    homes.push(home);
    expect(run(home, 'create').code).toBe(2);
    expect(run(home, 'create', ['bad\u0007label']).code).toBe(1);
    expect(run(home, 'create', ['x'.repeat(65)]).code).toBe(1);
    expect(run(home, 'rotate').code).toBe(2);
    expect(run(home, undefined).code).toBe(0);
  });

  it('fails closed on a damaged credential file rather than treating it as empty', async () => {
    const home = mkdtempSync(join(tmpdir(), 'salidium-consumer-cli-'));
    homes.push(home);
    const { token } = JSON.parse(run(home, 'create', ['tool'], true).out) as { token: string };
    const { writeFileSync } = await import('node:fs');
    writeFileSync(consumerCredentialPath(home), '{"version":1,"credentials":[{"id":"x"}]}');
    const reasons: string[] = [];
    expect(
      new ConsumerCredentialVerifier(home, (r) => reasons.push(r)).verify(token),
    ).toBeUndefined();
    expect(reasons).toHaveLength(1);
    expect(run(home, 'list').code).toBe(1);
    expect(run(home, 'create', ['another']).code).toBe(1);
  });
});
