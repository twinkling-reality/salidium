import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectCodexHookTrust,
  MAX_CODEX_HOOK_TRUST_OUTPUT_BYTES,
  summarizeCodexHookTrustResponse,
} from './codexHookTrust.ts';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function response(statuses: string[], includeOther = false): Record<string, unknown> {
  return {
    id: 2,
    result: {
      data: [
        {
          hooks: [
            ...statuses.map((trustStatus) => ({
              command: "SALIDIUM_HOOK=1 '/home/.salidium/hooks/relay.sh' codex Stop lifecycle",
              trustStatus,
            })),
            ...(includeOther ? [{ command: 'other hook', trustStatus: 'modified' }] : []),
          ],
        },
      ],
    },
  };
}

describe('Codex hook trust inspection', () => {
  it('uses only Salidium commands and reports the least trusted current definition', () => {
    expect(summarizeCodexHookTrustResponse(response(['trusted', 'untrusted'], true))).toEqual({
      trust: 'untrusted',
      hooks: 2,
    });
    expect(summarizeCodexHookTrustResponse(response(['trusted', 'modified']))).toEqual({
      trust: 'modified',
      hooks: 2,
    });
  });

  it('does not turn an absent resolved hook into a trust claim', () => {
    expect(summarizeCodexHookTrustResponse(response([], true))).toEqual({
      trust: 'unknown',
      hooks: 0,
      issue: 'no Salidium hooks resolved',
    });
  });

  it('can be cancelled during daemon shutdown without leaving a child inspection alive', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      inspectCodexHookTrust(process.cwd(), process.env, 3_000, controller.signal),
    ).resolves.toMatchObject({ trust: 'unknown', issue: expect.stringMatching(/cancelled/i) });
  });

  it('bounds hostile protocol output and terminates the probe', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'salidium-codex-probe-'));
    directories.push(directory);
    const bin = join(directory, 'bin');
    mkdirSync(bin);
    const command = join(bin, 'codex');
    writeFileSync(
      command,
      '#!/bin/sh\nwhile :; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; done\n',
    );
    chmodSync(command, 0o700);

    await expect(
      inspectCodexHookTrust(process.cwd(), { PATH: bin, HOME: directory }, 3_000),
    ).resolves.toEqual({
      trust: 'unknown',
      hooks: 0,
      issue: `codex hook trust output exceeded ${MAX_CODEX_HOOK_TRUST_OUTPUT_BYTES} bytes`,
    });
  });
});
