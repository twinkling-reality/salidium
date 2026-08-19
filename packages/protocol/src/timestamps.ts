import { z } from 'zod';

/**
 * The only timestamp representation allowed in canonical events and daemon wire messages.
 *
 * Requiring UTC, exactly three fractional digits, and the trailing `Z` means timestamps can be
 * compared lexicographically without first guessing which offset or precision a producer used.
 * Provider adapters may accept other RFC 3339 offsets at their boundary, but must normalize them
 * before constructing a canonical event.
 */
export const CanonicalTimestampSchema = z.iso.datetime({ offset: false, precision: 3 });
export type CanonicalTimestamp = z.infer<typeof CanonicalTimestampSchema>;

/** Adapter-boundary input: RFC 3339 with an explicit `Z` or numeric offset, any precision. */
export const ProviderTimestampSchema = z.iso.datetime({ offset: true });
