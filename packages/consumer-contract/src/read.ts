import { type FeedMessage, FeedMessageSchema } from './schemas.ts';

/**
 * Reads one feed `data:` payload the way the compatibility rules require.
 *
 * A message type this version does not know returns `null` so the caller skips it: a later minor
 * version may add message types, and a consumer that throws on one would break on an additive
 * change. A known type that fails validation still throws, because that is a defect rather than
 * evolution.
 */
export function readFeedMessage(data: string | unknown): FeedMessage | null {
  const value: unknown = typeof data === 'string' ? JSON.parse(data) : data;
  const type = (value as { type?: unknown } | null)?.type;
  const known = FeedMessageSchema.options.some((option) => option.shape.type.value === type);
  if (!known) return null;
  return FeedMessageSchema.parse(value);
}
