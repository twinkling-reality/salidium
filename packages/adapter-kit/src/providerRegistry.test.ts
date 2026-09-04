import { describe, expect, it } from 'vitest';
import type { ProviderAdapter } from './providerAdapter.ts';
import {
  PROVIDER_ADAPTER_CONTRACT_VERSION,
  type ProviderDescriptor,
  ProviderRegistry,
} from './providerRegistry.ts';

function descriptor(id: ProviderAdapter['id'], displayName = 'Test provider'): ProviderDescriptor {
  return {
    contractVersion: PROVIDER_ADAPTER_CONTRACT_VERSION,
    displayName,
    hookEventBudget: { expectedPerTurn: { fixed: 0, perToolCall: 0 }, events: [] },
    adapter: {
      id,
      sessionRoots: () => [],
      matchSessionFile: () => undefined,
      createRecordParser: () => ({ parseRecord: () => [] }),
      parseHookPayload: () => [],
      transcriptPathFromHook: () => undefined,
    },
  };
}

describe('ProviderRegistry', () => {
  it('resolves built-in and namespaced adapters in configured order', () => {
    const registry = new ProviderRegistry([
      descriptor('codex', 'Codex'),
      descriptor('example/acme-agent', 'Acme Agent'),
    ]);

    expect(
      registry.adaptersFor(['example/acme-agent', 'codex']).map((adapter) => adapter.id),
    ).toEqual(['example/acme-agent', 'codex']);
  });

  it('rejects duplicate, unnamespaced extension, and incompatible descriptors', () => {
    const registry = new ProviderRegistry([descriptor('claude-code', 'Claude Code')]);
    expect(() => registry.register(descriptor('claude-code', 'Again'))).toThrow(
      /already registered/,
    );
    expect(() => registry.register(descriptor('third-party' as ProviderAdapter['id']))).toThrow(
      /extension provider id/,
    );
    expect(() =>
      registry.register({ ...descriptor('example/acme-agent'), contractVersion: 3 as 2 }),
    ).toThrow(/unsupported contract/);
  });

  it('rejects hook event budgets that are missing cost or classify an event twice', () => {
    const base = descriptor('example/acme-agent');
    expect(
      () =>
        new ProviderRegistry([
          {
            ...base,
            hookEventBudget: {
              expectedPerTurn: { fixed: 0, perToolCall: 0 },
              events: [{ name: 'Stop', pressure: 'lifecycle' }],
            },
          },
        ]),
    ).toThrow(/without a traffic budget/);
    expect(
      () =>
        new ProviderRegistry([
          {
            ...base,
            hookEventBudget: {
              expectedPerTurn: { fixed: 2, perToolCall: 2 },
              events: [
                { name: 'PreToolUse', pressure: 'shed-first' },
                { name: 'PreToolUse', pressure: 'retain' },
              ],
            },
          },
        ]),
    ).toThrow(/more than once/);
  });
});
