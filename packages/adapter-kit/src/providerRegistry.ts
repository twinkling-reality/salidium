import { type ProviderId, ProviderIdSchema } from '@salidium/protocol';
import type { ProviderAdapter } from './providerAdapter.ts';

/** Increment only for an intentional, documented break in the adapter contract. */
export const PROVIDER_ADAPTER_CONTRACT_VERSION = 1 as const;

export interface ProviderDescriptor {
  contractVersion: typeof PROVIDER_ADAPTER_CONTRACT_VERSION;
  /** Human-readable name used by setup and diagnostic surfaces. */
  displayName: string;
  adapter: ProviderAdapter;
}

/**
 * A deliberately explicit provider registry.
 *
 * Runtime code receives descriptors instead of importing provider packages in discovery paths.
 * Registration validates contract versions and ids and rejects duplicates. This is the safe
 * extension seam for built-ins and embedding applications; loading arbitrary project-local code is
 * intentionally a separate security decision, not a side effect of scanning node_modules.
 */
export class ProviderRegistry {
  private readonly descriptors = new Map<ProviderId, ProviderDescriptor>();

  constructor(descriptors: readonly ProviderDescriptor[] = []) {
    for (const descriptor of descriptors) this.register(descriptor);
  }

  register(descriptor: ProviderDescriptor): void {
    if (descriptor.contractVersion !== PROVIDER_ADAPTER_CONTRACT_VERSION) {
      throw new Error(
        `provider adapter ${descriptor.adapter.id} uses unsupported contract ${String(descriptor.contractVersion)}`,
      );
    }
    const id = ProviderIdSchema.parse(descriptor.adapter.id);
    if (!descriptor.displayName.trim())
      throw new Error(`provider adapter ${id} has no display name`);
    if (this.descriptors.has(id)) throw new Error(`provider adapter ${id} is already registered`);
    this.descriptors.set(id, descriptor);
  }

  get(id: ProviderId): ProviderDescriptor | undefined {
    return this.descriptors.get(id);
  }

  list(): readonly ProviderDescriptor[] {
    return [...this.descriptors.values()];
  }

  adaptersFor(ids: readonly ProviderId[]): ProviderAdapter[] {
    return ids.map((id) => {
      const descriptor = this.descriptors.get(id);
      if (!descriptor) throw new Error(`provider adapter ${id} is not registered`);
      return descriptor.adapter;
    });
  }
}
