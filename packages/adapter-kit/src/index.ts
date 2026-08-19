/**
 * @salidium/adapter-kit — the contract every provider adapter implements, plus small helpers
 * shared by adapters (excerpts, hunk line counting, tool titles). Adapters are pure parsers:
 * they turn provider records and hook payloads into canonical events and never touch I/O.
 * The daemon owns file watching, tailing, HTTP ingress, and persistence.
 */
export type {
  HookInstallPlan,
  HookParseContext,
  ProviderAdapter,
  RecordParser,
  RecordParserContext,
  SessionFileMatch,
} from './providerAdapter.ts';
export {
  PROVIDER_ADAPTER_CONTRACT_VERSION,
  type ProviderDescriptor,
  ProviderRegistry,
} from './providerRegistry.ts';
export {
  asObject,
  asString,
  countHunkLines,
  excerpt,
  hunksFromUnifiedDiff,
  normalizeProviderTimestamp,
  pathArgumentMetadata,
  safeJson,
} from './recordHelpers.ts';
export {
  resolveTrustedExecutable,
  type TrustedPathOptions,
  trustedPathEntries,
} from './trustedExecutable.ts';
