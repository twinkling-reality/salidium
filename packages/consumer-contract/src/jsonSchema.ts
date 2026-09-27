import { z } from 'zod';
import {
  CONSUMER_CONTRACT,
  ConsumerDiscoverySchema,
  ConsumerErrorSchema,
  FeedMessageSchema,
  SessionListSchema,
  SessionLookupSchema,
  SessionReportSchema,
} from './schemas.ts';

/** One JSON Schema file per document, named by its `format`. */
export const CONSUMER_DOCUMENTS = {
  'consumer-discovery': ConsumerDiscoverySchema,
  'consumer-error': ConsumerErrorSchema,
  'session-feed': FeedMessageSchema,
  'session-list': SessionListSchema,
  'session-lookup': SessionLookupSchema,
  'session-report': SessionReportSchema,
} as const;
export type ConsumerDocumentName = keyof typeof CONSUMER_DOCUMENTS;

/**
 * The JSON Schema for one document, derived from the zod source of truth.
 *
 * Generated in `input` mode on purpose. In that mode objects are left open, which is the
 * compatibility promise: a consumer validating with the schema of minor version 0 still accepts a
 * document from minor version 1 that added a property. Required properties, types, enumerations,
 * and bounds are all still enforced. Salidium's own tests hold the producer to the closed form.
 */
export function consumerJsonSchema(name: ConsumerDocumentName): Record<string, unknown> {
  const generated = z.toJSONSchema(CONSUMER_DOCUMENTS[name], {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'throw',
  }) as Record<string, unknown>;
  const { $schema, ...rest } = generated;
  return {
    $schema,
    $id: `urn:salidium:consumer:${CONSUMER_CONTRACT.major}:${name}`,
    title: `salidium.${name}`,
    ...rest,
  };
}

/** Exactly the bytes committed under `schema/v1/`, so a test can compare them. */
export function consumerJsonSchemaText(name: ConsumerDocumentName): string {
  return `${JSON.stringify(consumerJsonSchema(name), null, 2)}\n`;
}
