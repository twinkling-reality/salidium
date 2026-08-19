import { z } from 'zod';
import { EpistemicSchema } from './provenance.ts';
import { CanonicalTimestampSchema } from './timestamps.ts';

/**
 * The facets of semantic state a developer cares about. These are the product vocabulary
 * (What / Why / How / Verified / Left / Review) plus the operational facets that feed the
 * status strip. History is a log of changes to these facets over time.
 */
export const FacetSchema = z.enum([
  'status', // running / idle / waiting / failing; turn boundaries
  'what', // what the agent is doing / changed (files, commands, commits)
  'why', // rationale, discoveries (agent-reported)
  'how', // approach, plan (agent-reported / planned)
  'verified', // evidence of checks (tests, builds, typechecks)
  'left', // remaining work
  'review', // things a human should look at
]);
export type Facet = z.infer<typeof FacetSchema>;

/**
 * One entry of the semantic history: "at 10:40, the Verified facet changed: 3 tests failed".
 * Produced by the reducer as a side effect of folding an event; persisted; scrubbable.
 * `seq` is the sequence number of the event that caused the change, so any change can be
 * traced back to its raw evidence and the state at that moment can be reconstructed by
 * replaying events up to `seq`.
 */
export const SemanticChangeSchema = z.object({
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  /** Several changes may result from one event; ordinal keeps them ordered and unique. */
  ordinal: z.number().int().nonnegative(),
  ts: CanonicalTimestampSchema,
  facet: FacetSchema,
  /** ≤ 160 chars, deterministic template or an attributed quote. */
  summary: z.string(),
  epistemic: EpistemicSchema,
  /** Event ids this change is derived from (usually the causing event). */
  refs: z.array(z.string()),
  /** Optional structured detail for the UI (counts, paths); small. */
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type SemanticChange = z.infer<typeof SemanticChangeSchema>;
