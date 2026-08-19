import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CanonicalTimestampSchema,
  CONSENT_GRANT_CONTRACT,
  ConsentGrantV1Schema,
  ConsentReferenceSchema,
  DeletionReasonSchema,
  IntelligenceItemV1Schema,
  OpaqueIdSchema,
  PersonalScopeSchema,
  Sha256DigestSchema,
  SYNC_OPERATION_CONTRACT,
  SYNC_WIRE_VERSION,
} from './schemas.ts';

export const SYNC_BATCH_MAX_OPERATIONS = 100;
export const SYNC_BATCH_MAX_BYTES = 256 * 1024;
export const SyncLaneSchema = z.enum(['control', 'data']);
export type SyncLane = z.infer<typeof SyncLaneSchema>;

const OperationBase = {
  contract: z.literal(SYNC_OPERATION_CONTRACT),
  contractVersion: z.literal(SYNC_WIRE_VERSION),
  streamId: OpaqueIdSchema,
  replicaId: OpaqueIdSchema,
  lane: SyncLaneSchema,
  position: z.number().int().nonnegative(),
  operationId: OpaqueIdSchema,
  previousOperationId: OpaqueIdSchema.optional(),
  occurredAt: CanonicalTimestampSchema,
  contentDigest: Sha256DigestSchema,
} as const;

const ConsentPutOperationSchema = z.strictObject({
  ...OperationBase,
  lane: z.literal('control'),
  type: z.literal('consent.put'),
  grant: ConsentGrantV1Schema,
});

const ConsentRevokeOperationSchema = z.strictObject({
  ...OperationBase,
  lane: z.literal('control'),
  type: z.literal('consent.revoke'),
  grant: ConsentGrantV1Schema.refine((grant) => grant.status === 'revoked', {
    message: 'consent.revoke requires a revoked grant revision',
  }),
});

const ItemPutOperationSchema = z.strictObject({
  ...OperationBase,
  lane: z.literal('data'),
  type: z.literal('item.put'),
  grant: ConsentReferenceSchema,
  item: IntelligenceItemV1Schema,
});

const ItemDeleteOperationSchema = z.strictObject({
  ...OperationBase,
  lane: z.literal('control'),
  type: z.literal('item.delete'),
  grant: ConsentReferenceSchema,
  scope: PersonalScopeSchema,
  itemId: OpaqueIdSchema,
  deleteThroughRevision: z.number().int().positive(),
  reason: DeletionReasonSchema,
  requestedAt: CanonicalTimestampSchema,
});

const ScopeDeleteOperationSchema = z.strictObject({
  ...OperationBase,
  lane: z.literal('control'),
  type: z.literal('scope.delete'),
  grant: ConsentReferenceSchema,
  scope: PersonalScopeSchema,
  reason: DeletionReasonSchema,
  requestedAt: CanonicalTimestampSchema,
});

export const SyncOperationV1Schema = z
  .discriminatedUnion('type', [
    ConsentPutOperationSchema,
    ConsentRevokeOperationSchema,
    ItemPutOperationSchema,
    ItemDeleteOperationSchema,
    ScopeDeleteOperationSchema,
  ])
  .superRefine((operation, ctx) => {
    if (operation.position === 0 && operation.previousOperationId !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['previousOperationId'],
        message: 'first operation has no predecessor',
      });
    }
    if (operation.position > 0 && operation.previousOperationId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['previousOperationId'],
        message: 'later operations require a predecessor',
      });
    }
    if (operation.type === 'item.put') {
      if (
        operation.grant.grantId !== operation.item.consent.grantId ||
        operation.grant.revision !== operation.item.consent.revision
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['grant'],
          message: 'operation and item must cite the same grant revision',
        });
      }
    }
  });
export type SyncOperationV1 = z.infer<typeof SyncOperationV1Schema>;

export const SyncBatchV1Schema = z
  .strictObject({
    contract: z.literal('salidium.sync-batch'),
    contractVersion: z.literal(SYNC_WIRE_VERSION),
    streamId: OpaqueIdSchema,
    replicaId: OpaqueIdSchema,
    lane: SyncLaneSchema,
    afterPosition: z.number().int().min(-1),
    operations: z.array(SyncOperationV1Schema).min(1).max(SYNC_BATCH_MAX_OPERATIONS),
  })
  .superRefine((batch, ctx) => {
    for (const [index, operation] of batch.operations.entries()) {
      if (
        operation.streamId !== batch.streamId ||
        operation.replicaId !== batch.replicaId ||
        operation.lane !== batch.lane
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['operations', index],
          message: 'operation belongs to another stream, replica, or lane',
        });
      }
      if (operation.position !== batch.afterPosition + index + 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['operations', index, 'position'],
          message: 'batch positions must be contiguous',
        });
      }
      const predecessor = index === 0 ? undefined : batch.operations[index - 1];
      if (predecessor && operation.previousOperationId !== predecessor.operationId) {
        ctx.addIssue({
          code: 'custom',
          path: ['operations', index, 'previousOperationId'],
          message: 'operation chain is not contiguous',
        });
      }
    }
  });
export type SyncBatchV1 = z.infer<typeof SyncBatchV1Schema>;

export const SyncAckV1Schema = z.strictObject({
  contract: z.literal('salidium.sync-ack'),
  contractVersion: z.literal(SYNC_WIRE_VERSION),
  streamId: OpaqueIdSchema,
  lane: SyncLaneSchema,
  acceptedThrough: z.number().int().min(-1),
  retryAfterMs: z.number().int().min(100).max(86_400_000).optional(),
  rejection: z
    .strictObject({
      position: z.number().int().nonnegative(),
      code: z.enum([
        'content-conflict',
        'grant-revoked',
        'incompatible-version',
        'invalid-record',
        'scope-denied',
        'rate-limited',
        'temporary-failure',
      ]),
      retryable: z.boolean(),
    })
    .optional(),
  reconciliationRequired: z.enum(['cursor-ahead', 'history-gap', 'inventory-mismatch']).optional(),
});
export type SyncAckV1 = z.infer<typeof SyncAckV1Schema>;

const DeletionTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('item'),
    itemId: OpaqueIdSchema,
    deleteThroughRevision: z.number().int().positive(),
  }),
  z.strictObject({ kind: z.literal('scope'), scope: PersonalScopeSchema }),
]);

const DELETION_SINKS = [
  'ledger',
  'projection',
  'search',
  'embedding',
  'cache',
  'backup-fence',
] as const;

export const DeletionReceiptV1Schema = z
  .strictObject({
    contract: z.literal('salidium.deletion-receipt'),
    contractVersion: z.literal(SYNC_WIRE_VERSION),
    receiptId: OpaqueIdSchema,
    destinationId: OpaqueIdSchema,
    operationId: OpaqueIdSchema,
    target: DeletionTargetSchema,
    completedAt: CanonicalTimestampSchema,
    sinks: z.array(z.enum(DELETION_SINKS)).length(DELETION_SINKS.length),
  })
  .refine((receipt) => new Set(receipt.sinks).size === DELETION_SINKS.length, {
    path: ['sinks'],
    message: 'deletion completion must cover each durable sink exactly once',
  });

export const ReconciliationInventoryV1Schema = z.strictObject({
  contract: z.literal('salidium.reconciliation-inventory'),
  contractVersion: z.literal(SYNC_WIRE_VERSION),
  streamId: OpaqueIdSchema,
  cursor: z.string().max(500).optional(),
  complete: z.boolean(),
  live: z
    .array(z.strictObject({ itemId: OpaqueIdSchema, revision: z.number().int().positive() }))
    .max(1_000),
  tombstones: z
    .array(
      z.strictObject({
        itemId: OpaqueIdSchema,
        deleteThroughRevision: z.number().int().positive(),
      }),
    )
    .max(1_000),
});

export function canonicalJson(value: unknown): string {
  if (value === undefined) throw new Error('canonical JSON does not support undefined');
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('value is not JSON serializable');
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

export function digestCanonical(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function sealSyncOperation(value: unknown): SyncOperationV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('sync operation must be an object');
  }
  const unsigned = { ...(value as Record<string, unknown>) };
  if ('contentDigest' in unsigned)
    throw new Error('unsigned operation must not contain contentDigest');
  return SyncOperationV1Schema.parse({ ...unsigned, contentDigest: digestCanonical(unsigned) });
}

export function verifySyncOperationDigest(operation: SyncOperationV1): boolean {
  const unsigned = { ...operation } as Record<string, unknown>;
  delete unsigned.contentDigest;
  return operation.contentDigest === digestCanonical(unsigned);
}

export function serializedBatchBytes(batch: SyncBatchV1): number {
  return Buffer.byteLength(JSON.stringify(batch));
}

export function assertSendableBatch(value: unknown): SyncBatchV1 {
  const batch = SyncBatchV1Schema.parse(value);
  if (serializedBatchBytes(batch) > SYNC_BATCH_MAX_BYTES)
    throw new Error('sync batch exceeds byte limit');
  for (const operation of batch.operations) {
    if (!verifySyncOperationDigest(operation))
      throw new Error(`sync operation ${operation.operationId} has an invalid digest`);
  }
  return batch;
}

// Referenced here so tree-shaken consumers still see the consent contract in generated declarations.
export const SyncConsentContractName = CONSENT_GRANT_CONTRACT;
