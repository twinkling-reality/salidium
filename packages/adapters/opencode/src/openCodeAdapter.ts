import {
  PROVIDER_ADAPTER_CONTRACT_VERSION,
  type ProviderAdapter,
  type ProviderDescriptor,
} from '@salidium/adapter-kit';
import { OPENCODE_PROVIDER_ID } from './mapping.ts';
import { createOpenCodeStoreSource } from './storeSource.ts';

/**
 * OpenCode 2.x, observed read only from its own store. Salidium never connects to an OpenCode
 * server, installs an OpenCode plugin, or changes OpenCode's configuration, so there are no hooks
 * and no session files: every record comes through the store source.
 */
export const openCodeAdapter: ProviderAdapter = {
  id: OPENCODE_PROVIDER_ID,
  sessionRoots() {
    return [];
  },
  matchSessionFile() {
    return undefined;
  },
  createRecordParser() {
    return { parseRecord: () => [] };
  },
  parseHookPayload() {
    return [];
  },
  transcriptPathFromHook() {
    return undefined;
  },
};

export const openCodeProvider = {
  contractVersion: PROVIDER_ADAPTER_CONTRACT_VERSION,
  displayName: 'OpenCode',
  hookEventBudget: { expectedPerTurn: { fixed: 0, perToolCall: 0 }, events: [] },
  adapter: openCodeAdapter,
  storeSource: createOpenCodeStoreSource(),
} satisfies ProviderDescriptor;
