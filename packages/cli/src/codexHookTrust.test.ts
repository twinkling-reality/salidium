import { describe, expect, it } from 'vitest';
import { summarizeCodexHookTrustResponse } from './codexHookTrust.ts';

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
});
