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
      registry.register({ ...descriptor('example/acme-agent'), contractVersion: 2 as 1 }),
    ).toThrow(/unsupported contract/);
  });
});
