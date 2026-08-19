import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createRedactor } from '@salidium/core';
import {
  assertSendableBatch,
  type ConsentGrantV1,
  ConsentGrantV1Schema,
  type DecisionItem,
  DecisionItemSchema,
  DeletionReceiptV1Schema,
  digestCanonical,
  type EvidenceReference,
  type IntelligenceItemV1,
  IntelligenceItemV1Schema,
  type Sensitivity,
  SYNC_BATCH_MAX_BYTES,
  SYNC_BATCH_MAX_OPERATIONS,
  SYNC_WIRE_VERSION,
  type SyncAckV1,
  SyncAckV1Schema,
  type SyncBatchV1,
  type SyncLane,
  type SyncOperationV1,
  SyncOperationV1Schema,
  sealSyncOperation,
} from '@salidium/sync-contract';
import { z } from 'zod';

const REQUIRED_STORE_SCHEMA = 6;
const SUPPORTED_REDACTION_POLICY = 'secrets-v1';
const SUPPORTED_MINIMIZATION_POLICY = 'decision-v1';
const SENSITIVITY: Record<Sensitivity, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

export interface SyncStream {
  streamId: string;
  replicaId: string;
  destinationId: string;
  acknowledged: Record<SyncLane, number>;
}

export interface LocalEvidenceInput {
  /** Local-only lookup. These identifiers are never serialized into an outbox operation. */
  sessionId?: string;
  eventId?: string;
  authority: EvidenceReference['authority'];
  role?: EvidenceReference['role'];
  capturedAt: string;
  independenceId?: string;
}

export interface CaptureDecisionInput {
  grant: { grantId: string; revision: number };
  capturedAt: string;
  effectiveFrom?: string;
  retentionExpiresAt: string;
  sensitivity: Sensitivity;
  question?: string;
  selected: string;
  rationale: string;
  status?: DecisionItem['status'];
  alternatives: DecisionItem['alternatives'];
  evidence?: LocalEvidenceInput[];
}

export interface ReviseDecisionInput extends Omit<CaptureDecisionInput, 'grant'> {
  relation: 'corrects' | 'supersedes';
}

type DeletionReceipt = z.infer<typeof DeletionReceiptV1Schema>;

/**
 * Internal local outbox. It reads and writes only schema-6 sync tables in Salidium's SQLite file;
 * it is not an implementation of `SalidiumStore` and is not an external cloud extension API.
 *
 * There is intentionally no network code here. A future sender may read committed batches only
 * after a user explicitly connects a released compatible destination.
 */
export class SqliteSyncOutbox {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;',
    );
    const row = this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
      | { value?: unknown }
      | undefined;
    if (Number(row?.value) !== REQUIRED_STORE_SCHEMA) {
      this.db.close();
      throw new Error(`sync outbox requires Salidium store schema ${REQUIRED_STORE_SCHEMA}`);
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private replicaId(): string {
    const existing = this.db
      .prepare('SELECT replica_id FROM sync_identity WHERE singleton=1')
      .get() as { replica_id: string } | undefined;
    if (existing) return existing.replica_id;
    const replicaId = randomUUID();
    this.db
      .prepare('INSERT INTO sync_identity (singleton, replica_id, created_at) VALUES (1, ?, ?)')
      .run(replicaId, new Date().toISOString());
    return replicaId;
  }

  createStream(destinationId: string, now = new Date()): SyncStream {
    const parsedDestination = z.uuid().parse(destinationId);
    return this.transaction(() => {
      const existing = this.db
        .prepare('SELECT stream_id FROM sync_streams WHERE destination_id=?')
        .get(parsedDestination) as { stream_id: string } | undefined;
      if (existing) return this.stream(existing.stream_id);
      const streamId = randomUUID();
      const replicaId = this.replicaId();
      this.db
        .prepare(
          `INSERT INTO sync_streams
           (stream_id, replica_id, destination_id, created_at) VALUES (?, ?, ?, ?)`,
        )
        .run(streamId, replicaId, parsedDestination, now.toISOString());
      return this.stream(streamId);
    });
  }

  stream(streamId: string): SyncStream {
    const row = this.db
      .prepare(
        `SELECT stream_id, replica_id, destination_id,
                acknowledged_control_position, acknowledged_data_position
           FROM sync_streams WHERE stream_id=?`,
      )
      .get(streamId) as
      | {
          stream_id: string;
          replica_id: string;
          destination_id: string;
          acknowledged_control_position: number;
          acknowledged_data_position: number;
        }
      | undefined;
    if (!row) throw new Error(`unknown sync stream ${streamId}`);
    return {
      streamId: row.stream_id,
      replicaId: row.replica_id,
      destinationId: row.destination_id,
      acknowledged: {
        control: row.acknowledged_control_position,
        data: row.acknowledged_data_position,
      },
    };
  }

  grantConsent(streamId: string, value: ConsentGrantV1): ConsentGrantV1 {
    const grant = ConsentGrantV1Schema.parse(value);
    if (grant.status !== 'active') throw new Error('a new consent grant must be active');
    // Phase 0 deliberately produces decision threads only. Broader vocabulary exists so later
    // producers cannot collapse kinds, but a grant cannot activate producers that do not exist.
    if (grant.allowedKinds.length !== 1 || grant.allowedKinds[0] !== 'decision') {
      throw new Error('Phase 0 consent may authorize decision records only');
    }
    if (
      grant.redactionPolicyVersion !== SUPPORTED_REDACTION_POLICY ||
      grant.minimizationPolicyVersion !== SUPPORTED_MINIMIZATION_POLICY
    ) {
      throw new Error('consent names an unsupported local redaction or minimization policy');
    }
    return this.transaction(() => {
      const stream = this.stream(streamId);
      if (grant.destinationId !== stream.destinationId)
        throw new Error('grant destination does not match stream');
      const previous = this.currentGrant(streamId, grant.grantId);
      if (previous && grant.revision !== previous.revision + 1)
        throw new Error('consent revision must advance by one');
      if (!previous && grant.revision !== 1) throw new Error('first consent revision must be one');
      this.insertGrant(streamId, grant);
      this.enqueue(stream, 'control', 'consent.put', { grant }, grant.grantId);
      return grant;
    });
  }

  revokeConsent(streamId: string, grantId: string, revokedAt = new Date()): ConsentGrantV1 {
    return this.transaction(() => {
      const stream = this.stream(streamId);
      const current = this.currentGrant(streamId, grantId);
      if (!current) throw new Error('unknown consent grant');
      if (current.status === 'revoked') return current;
      const revoked = ConsentGrantV1Schema.parse({
        ...current,
        revision: current.revision + 1,
        status: 'revoked',
        revokedAt: revokedAt.toISOString(),
      });
      this.insertGrant(streamId, revoked);
      this.enqueue(stream, 'control', 'consent.revoke', { grant: revoked }, revoked.grantId);
      this.enqueue(
        stream,
        'control',
        'scope.delete',
        {
          grant: { grantId: revoked.grantId, revision: revoked.revision },
          scope: revoked.scope,
          reason: 'consent-withdrawn',
          requestedAt: revokedAt.toISOString(),
        },
        revoked.grantId,
      );
      return revoked;
    });
  }

  captureDecision(streamId: string, input: CaptureDecisionInput): DecisionItem {
    return this.transaction(() => {
      const stream = this.stream(streamId);
      const grant = this.authorizingGrant(streamId, input.grant, input.capturedAt);
      const evidence = this.recordEvidence(input.evidence ?? [], input.capturedAt);
      const minimized = this.minimizeDecisionFields(input);
      const item = DecisionItemSchema.parse({
        contract: 'salidium.intelligence-item',
        contractVersion: SYNC_WIRE_VERSION,
        itemId: randomUUID(),
        originReplicaId: stream.replicaId,
        revision: 1,
        kind: 'decision',
        scope: grant.scope,
        capturedAt: input.capturedAt,
        effectiveFrom: input.effectiveFrom ?? input.capturedAt,
        epistemic: 'reported',
        assessment: {
          mode: 'verification',
          state: 'verified',
          method: { id: 'explicit-user-confirmation', version: '1' },
        },
        sensitivity: input.sensitivity,
        lifecycle: {
          state: 'active',
          validFrom: input.effectiveFrom ?? input.capturedAt,
          retention: {
            policyId: `consent-${grant.retentionMaximumDays}d`,
            expiresAt: input.retentionExpiresAt,
            deleteWithEvidence: true,
          },
        },
        consent: input.grant,
        evidence,
        links: [],
        redactionPolicyVersion: grant.redactionPolicyVersion,
        minimizationPolicyVersion: grant.minimizationPolicyVersion,
        question: minimized.question,
        selected: minimized.selected,
        rationale: minimized.rationale,
        owner: 'authenticated-user',
        status: input.status ?? 'active',
        alternatives: minimized.alternatives,
      });
      this.assertEligible(grant, item);
      this.insertItem(stream, item);
      return item;
    });
  }

  reviseDecision(streamId: string, itemId: string, input: ReviseDecisionInput): DecisionItem {
    return this.transaction(() => {
      const stream = this.stream(streamId);
      const current = this.currentItem(streamId, itemId);
      if (current?.kind !== 'decision') throw new Error('unknown decision item');
      const grant = this.authorizingGrant(streamId, current.consent, input.capturedAt);
      const evidence = this.recordEvidence(input.evidence ?? [], input.capturedAt);
      const minimized = this.minimizeDecisionFields(input);
      const relation = input.relation;
      const item = DecisionItemSchema.parse({
        ...current,
        revision: current.revision + 1,
        capturedAt: input.capturedAt,
        effectiveFrom: input.effectiveFrom ?? input.capturedAt,
        sensitivity: input.sensitivity,
        lifecycle: {
          state: 'active',
          validFrom: input.effectiveFrom ?? input.capturedAt,
          retention: {
            policyId: `consent-${grant.retentionMaximumDays}d`,
            expiresAt: input.retentionExpiresAt,
            deleteWithEvidence: true,
          },
        },
        evidence,
        links: [
          ...current.links,
          { relation, target: { itemId: current.itemId, revision: current.revision } },
        ],
        question: minimized.question,
        selected: minimized.selected,
        rationale: minimized.rationale,
        status: input.status ?? 'active',
        alternatives: minimized.alternatives,
      });
      this.assertEligible(grant, item);
      this.insertItem(stream, item);
      return item;
    });
  }

  deleteItem(
    streamId: string,
    itemId: string,
    reason: 'user-request' | 'retention-expired' | 'corrected' = 'user-request',
    requestedAt = new Date(),
  ): boolean {
    return this.transaction(() => {
      const stream = this.stream(streamId);
      const item = this.currentItem(streamId, itemId);
      if (!item) return false;
      const requested = requestedAt.toISOString();
      this.db
        .prepare('UPDATE intelligence_records SET current=0 WHERE stream_id=? AND item_id=?')
        .run(streamId, itemId);
      this.db
        .prepare(
          `INSERT INTO intelligence_tombstones
             (stream_id, item_id, delete_through_revision, reason, requested_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(stream_id, item_id) DO UPDATE SET
             delete_through_revision=MAX(delete_through_revision, excluded.delete_through_revision),
             reason=excluded.reason, requested_at=excluded.requested_at`,
        )
        .run(streamId, itemId, item.revision, reason, requested);
      this.enqueue(
        stream,
        'control',
        'item.delete',
        {
          grant: item.consent,
          scope: item.scope,
          itemId,
          deleteThroughRevision: item.revision,
          reason,
          requestedAt: requested,
        },
        item.consent.grantId,
        itemId,
      );
      return true;
    });
  }

  nextBatch(
    streamId: string,
    lane: SyncLane,
    limits: { operations?: number; bytes?: number } = {},
  ): SyncBatchV1 | undefined {
    const stream = this.stream(streamId);
    const after = stream.acknowledged[lane];
    const operationLimit = Math.min(
      Math.max(limits.operations ?? SYNC_BATCH_MAX_OPERATIONS, 1),
      SYNC_BATCH_MAX_OPERATIONS,
    );
    const byteLimit = Math.min(
      Math.max(limits.bytes ?? SYNC_BATCH_MAX_BYTES, 1_024),
      SYNC_BATCH_MAX_BYTES,
    );
    const rows = this.db
      .prepare(
        `SELECT json FROM sync_outbox
          WHERE stream_id=? AND lane=? AND position>?
          ORDER BY position LIMIT ?`,
      )
      .all(streamId, lane, after, operationLimit) as Array<{ json: string }>;
    if (!rows.length) return undefined;
    const operations: SyncOperationV1[] = [];
    for (const row of rows) {
      const operation = JSON.parse(row.json) as SyncOperationV1;
      const candidate = {
        contract: 'salidium.sync-batch' as const,
        contractVersion: SYNC_WIRE_VERSION,
        streamId,
        replicaId: stream.replicaId,
        lane,
        afterPosition: after,
        operations: [...operations, operation],
      };
      if (Buffer.byteLength(JSON.stringify(candidate)) > byteLimit) {
        if (operations.length === 0)
          throw new Error('one sync operation exceeds the batch byte limit');
        break;
      }
      operations.push(operation);
    }
    return assertSendableBatch({
      contract: 'salidium.sync-batch',
      contractVersion: SYNC_WIRE_VERSION,
      streamId,
      replicaId: stream.replicaId,
      lane,
      afterPosition: after,
      operations,
    });
  }

  acknowledge(value: SyncAckV1, acknowledgedAt = new Date()): void {
    const ack = SyncAckV1Schema.parse(value);
    this.transaction(() => {
      const stream = this.stream(ack.streamId);
      const current = stream.acknowledged[ack.lane];
      if (ack.acceptedThrough <= current) return;
      const positionColumn =
        ack.lane === 'control' ? 'next_control_position' : 'next_data_position';
      const next = this.db
        .prepare(`SELECT ${positionColumn} AS next_position FROM sync_streams WHERE stream_id=?`)
        .get(ack.streamId) as { next_position: number };
      if (ack.acceptedThrough >= next.next_position)
        throw new Error('acknowledgement is ahead of the local outbox');
      const count = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM sync_outbox
            WHERE stream_id=? AND lane=? AND position>? AND position<=?`,
        )
        .get(ack.streamId, ack.lane, current, ack.acceptedThrough) as { count: number };
      if (count.count !== ack.acceptedThrough - current)
        throw new Error('acknowledgement crosses a local history gap');
      const acknowledged = acknowledgedAt.toISOString();
      this.db
        .prepare(
          'UPDATE sync_outbox SET acknowledged_at=? WHERE stream_id=? AND lane=? AND position<=?',
        )
        .run(acknowledged, ack.streamId, ack.lane, ack.acceptedThrough);
      const acknowledgedColumn =
        ack.lane === 'control' ? 'acknowledged_control_position' : 'acknowledged_data_position';
      this.db
        .prepare(`UPDATE sync_streams SET ${acknowledgedColumn}=? WHERE stream_id=?`)
        .run(ack.acceptedThrough, ack.streamId);
    });
  }

  recordDeletionReceipt(value: DeletionReceipt): void {
    const receipt = DeletionReceiptV1Schema.parse(value);
    this.transaction(() => {
      const operation = this.db
        .prepare(
          `SELECT o.stream_id, o.json, s.destination_id
             FROM sync_outbox o JOIN sync_streams s ON s.stream_id=o.stream_id
            WHERE o.operation_id=?`,
        )
        .get(receipt.operationId) as
        | { stream_id: string; json: string; destination_id: string }
        | undefined;
      if (!operation) throw new Error('deletion receipt names an unknown operation');
      if (operation.destination_id !== receipt.destinationId)
        throw new Error('deletion receipt destination does not match the stream');
      const requested = SyncOperationV1Schema.parse(JSON.parse(operation.json));
      if (requested.type === 'item.delete') {
        if (
          receipt.target.kind !== 'item' ||
          receipt.target.itemId !== requested.itemId ||
          receipt.target.deleteThroughRevision !== requested.deleteThroughRevision
        ) {
          throw new Error('deletion receipt target does not match the requested item deletion');
        }
      } else if (requested.type === 'scope.delete') {
        if (
          receipt.target.kind !== 'scope' ||
          JSON.stringify(receipt.target.scope) !== JSON.stringify(requested.scope)
        ) {
          throw new Error('deletion receipt target does not match the requested scope deletion');
        }
      } else {
        throw new Error('deletion receipt names a non-deletion operation');
      }
      const parsed = value;
      this.db
        .prepare(
          `INSERT OR IGNORE INTO sync_deletion_receipts
             (receipt_id, stream_id, operation_id, json, completed_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.receiptId,
          operation.stream_id,
          parsed.operationId,
          JSON.stringify(parsed),
          parsed.completedAt,
        );
      if (parsed.target.kind === 'item') {
        this.db
          .prepare(
            `UPDATE intelligence_tombstones SET receipt_id=?, completed_at=?
              WHERE stream_id=? AND item_id=? AND delete_through_revision<=?`,
          )
          .run(
            parsed.receiptId,
            parsed.completedAt,
            operation.stream_id,
            parsed.target.itemId,
            parsed.target.deleteThroughRevision,
          );
      }
    });
  }

  inventory(streamId: string): {
    live: Array<{ itemId: string; revision: number }>;
    tombstones: Array<{ itemId: string; deleteThroughRevision: number }>;
  } {
    const live = this.db
      .prepare(
        `SELECT item_id, revision FROM intelligence_records
          WHERE stream_id=? AND current=1 ORDER BY item_id`,
      )
      .all(streamId) as Array<{ item_id: string; revision: number }>;
    const tombstones = this.db
      .prepare(
        `SELECT item_id, delete_through_revision FROM intelligence_tombstones
          WHERE stream_id=? ORDER BY item_id`,
      )
      .all(streamId) as Array<{ item_id: string; delete_through_revision: number }>;
    return {
      live: live.map((row) => ({ itemId: row.item_id, revision: row.revision })),
      tombstones: tombstones.map((row) => ({
        itemId: row.item_id,
        deleteThroughRevision: row.delete_through_revision,
      })),
    };
  }

  private currentGrant(streamId: string, grantId: string): ConsentGrantV1 | undefined {
    const row = this.db
      .prepare(
        `SELECT json FROM sync_consent_revisions
          WHERE stream_id=? AND grant_id=? ORDER BY revision DESC LIMIT 1`,
      )
      .get(streamId, grantId) as { json: string } | undefined;
    return row ? ConsentGrantV1Schema.parse(JSON.parse(row.json)) : undefined;
  }

  private authorizingGrant(
    streamId: string,
    reference: { grantId: string; revision: number },
    capturedAt: string,
  ): ConsentGrantV1 {
    const current = this.currentGrant(streamId, reference.grantId);
    if (!current || current.revision !== reference.revision)
      throw new Error('consent grant revision is stale');
    if (current.status !== 'active') throw new Error('consent grant is revoked');
    if (capturedAt < current.effectiveAt || capturedAt >= current.expiresAt)
      throw new Error('consent grant is not effective');
    return current;
  }

  private insertGrant(streamId: string, grant: ConsentGrantV1): void {
    this.db
      .prepare(
        `INSERT INTO sync_consent_revisions
           (stream_id, grant_id, revision, status, destination_id, json, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        streamId,
        grant.grantId,
        grant.revision,
        grant.status,
        grant.destinationId,
        JSON.stringify(grant),
        new Date().toISOString(),
      );
  }

  private recordEvidence(inputs: LocalEvidenceInput[], capturedAt: string): EvidenceReference[] {
    const sourceInputs = inputs.length
      ? inputs
      : [{ authority: 'user-explicit' as const, role: 'supports' as const, capturedAt }];
    return sourceInputs.map((input) => {
      const evidenceId = randomUUID();
      const independenceId = input.independenceId ?? randomUUID();
      const descriptor = {
        evidenceId,
        role: input.role ?? 'supports',
        authority: input.authority,
        capturedAt: input.capturedAt,
        independenceId,
      };
      const exportDigest = digestCanonical(descriptor);
      this.db
        .prepare(
          `INSERT INTO intelligence_evidence_map
             (evidence_id, independence_id, session_id, event_id, authority, role,
              captured_at, descriptor_digest, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          evidenceId,
          independenceId,
          input.sessionId ?? null,
          input.eventId ?? null,
          descriptor.authority,
          descriptor.role,
          descriptor.capturedAt,
          exportDigest,
          new Date().toISOString(),
        );
      return { ...descriptor, exportDigest };
    });
  }

  private assertEligible(grant: ConsentGrantV1, item: IntelligenceItemV1): void {
    if (grant.status !== 'active') throw new Error('consent grant is revoked');
    if (!grant.allowedKinds.includes(item.kind)) throw new Error('item kind is not consented');
    if (JSON.stringify(grant.scope) !== JSON.stringify(item.scope))
      throw new Error('item scope is not consented');
    if (SENSITIVITY[item.sensitivity] > SENSITIVITY[grant.maximumSensitivity])
      throw new Error('item sensitivity exceeds consent');
    if (item.lifecycle.retention.expiresAt > grant.expiresAt)
      throw new Error('item retention exceeds consent expiry');
    const maximum = new Date(
      Date.parse(item.capturedAt) + grant.retentionMaximumDays * 86_400_000,
    ).toISOString();
    if (item.lifecycle.retention.expiresAt > maximum)
      throw new Error('item retention exceeds consent maximum');
    if (
      item.redactionPolicyVersion !== grant.redactionPolicyVersion ||
      item.minimizationPolicyVersion !== grant.minimizationPolicyVersion
    ) {
      throw new Error('item policy versions do not match consent');
    }
  }

  /** Field allowlisting happens structurally; this second pass removes accidental credentials. */
  private minimizeDecisionFields(
    input: Pick<CaptureDecisionInput, 'question' | 'selected' | 'rationale' | 'alternatives'>,
  ): Pick<DecisionItem, 'question' | 'selected' | 'rationale' | 'alternatives'> {
    const redactor = createRedactor();
    const redact = (text: string) => {
      const result = redactor.redact(text);
      let minimized = result.text;
      // Session-local numbering is useful in the local report but is not a durable identity. Keep
      // exported markers deliberately non-linkable so two unrelated secrets cannot both become #1.
      for (const finding of result.findings.toReversed()) {
        const marker = minimized.slice(finding.start, finding.end).replace(/#\d+\]/g, ']');
        minimized = `${minimized.slice(0, finding.start)}${marker}${minimized.slice(finding.end)}`;
      }
      return minimized;
    };
    return {
      ...(input.question === undefined ? {} : { question: redact(input.question) }),
      selected: redact(input.selected),
      rationale: redact(input.rationale),
      alternatives: input.alternatives.map((alternative) => ({
        ...alternative,
        label: redact(alternative.label),
        rationale: redact(alternative.rationale),
      })),
    };
  }

  private insertItem(stream: SyncStream, item: IntelligenceItemV1): void {
    const current = this.currentItem(stream.streamId, item.itemId);
    if (current && item.revision !== current.revision + 1)
      throw new Error('item revision must advance by one');
    if (!current && item.revision !== 1) throw new Error('first item revision must be one');
    this.db
      .prepare('UPDATE intelligence_records SET current=0 WHERE stream_id=? AND item_id=?')
      .run(stream.streamId, item.itemId);
    this.db
      .prepare(
        `INSERT INTO intelligence_records
           (stream_id, item_id, revision, kind, grant_id, grant_revision, current, json, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        stream.streamId,
        item.itemId,
        item.revision,
        item.kind,
        item.consent.grantId,
        item.consent.revision,
        JSON.stringify(item),
        new Date().toISOString(),
      );
    this.enqueue(
      stream,
      'data',
      'item.put',
      { grant: item.consent, item },
      item.consent.grantId,
      item.itemId,
    );
  }

  private currentItem(streamId: string, itemId: string): IntelligenceItemV1 | undefined {
    const row = this.db
      .prepare(
        `SELECT json FROM intelligence_records
          WHERE stream_id=? AND item_id=? AND current=1 LIMIT 1`,
      )
      .get(streamId, itemId) as { json: string } | undefined;
    return row ? IntelligenceItemV1Schema.parse(JSON.parse(row.json)) : undefined;
  }

  private enqueue(
    stream: SyncStream,
    lane: SyncLane,
    type: SyncOperationV1['type'],
    body: Record<string, unknown>,
    grantId?: string,
    itemId?: string,
  ): SyncOperationV1 {
    const nextColumn = lane === 'control' ? 'next_control_position' : 'next_data_position';
    const previousColumn =
      lane === 'control' ? 'previous_control_operation_id' : 'previous_data_operation_id';
    const state = this.db
      .prepare(
        `SELECT ${nextColumn} AS position, ${previousColumn} AS previous FROM sync_streams WHERE stream_id=?`,
      )
      .get(stream.streamId) as { position: number; previous: string | null };
    const operationId = randomUUID();
    const operation = sealSyncOperation({
      contract: 'salidium.sync-operation',
      contractVersion: SYNC_WIRE_VERSION,
      streamId: stream.streamId,
      replicaId: stream.replicaId,
      lane,
      position: state.position,
      operationId,
      ...(state.previous ? { previousOperationId: state.previous } : {}),
      occurredAt: new Date().toISOString(),
      type,
      ...body,
    });
    this.db
      .prepare(
        `INSERT INTO sync_outbox
           (stream_id, lane, position, operation_id, operation_type, content_digest,
            grant_id, item_id, json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stream.streamId,
        lane,
        operation.position,
        operation.operationId,
        operation.type,
        operation.contentDigest,
        grantId ?? null,
        itemId ?? null,
        JSON.stringify(operation),
        operation.occurredAt,
      );
    this.db
      .prepare(`UPDATE sync_streams SET ${nextColumn}=?, ${previousColumn}=? WHERE stream_id=?`)
      .run(operation.position + 1, operation.operationId, stream.streamId);
    return operation;
  }

  close(): void {
    this.db.close();
  }
}
