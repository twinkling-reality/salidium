import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type ConsentGrantV1,
  type SyncBatchV1,
  verifySyncOperationDigest,
} from '@salidium/sync-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '../../daemon/src/storage/sqliteStore.ts';
import { SqliteSyncOutbox } from './sqliteSyncOutbox.ts';

const AT = '2026-08-19T12:00:00.000Z';
const EXPIRES = '2026-09-18T12:00:00.000Z';
const DESTINATION = '20000000-0000-4000-8000-000000000001';
const PROJECT = '20000000-0000-4000-8000-000000000002';
const GRANT = '20000000-0000-4000-8000-000000000003';
const SECRET_CANARY = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function open() {
  const dir = mkdtempSync(join(tmpdir(), 'salidium-sync-'));
  dirs.push(dir);
  const path = join(dir, 'store.db');
  new SqliteStore(path).close();
  const outbox = new SqliteSyncOutbox(path);
  return { path, outbox, stream: outbox.createStream(DESTINATION) };
}

function grant(overrides: Partial<ConsentGrantV1> = {}): ConsentGrantV1 {
  return {
    contract: 'salidium.consent-grant',
    contractVersion: 1,
    grantId: GRANT,
    revision: 1,
    destinationId: DESTINATION,
    scope: { kind: 'project', projectId: PROJECT },
    purpose: 'personal-continuity',
    allowedKinds: ['decision'],
    maximumSensitivity: 'internal',
    issuedAt: AT,
    effectiveAt: AT,
    expiresAt: EXPIRES,
    retentionMaximumDays: 30,
    redactionPolicyVersion: 'secrets-v1',
    minimizationPolicyVersion: 'decision-v1',
    rawEvidence: false,
    status: 'active',
    ...overrides,
  };
}

function capture(outbox: SqliteSyncOutbox, streamId: string) {
  return outbox.captureDecision(streamId, {
    grant: { grantId: GRANT, revision: 1 },
    capturedAt: AT,
    retentionExpiresAt: EXPIRES,
    sensitivity: 'internal',
    question: 'What should cross the public boundary?',
    selected: 'Only a minimized, user-confirmed decision thread.',
    rationale: `The raw record stays local even if a token is pasted: ${SECRET_CANARY}`,
    alternatives: [
      {
        label: 'Upload canonical events',
        disposition: 'rejected',
        rationale: 'They contain prompts, paths, commands, diffs, and output.',
      },
    ],
    evidence: EVIDENCE,
  });
}

const EVIDENCE = [
  {
    authority: 'user-explicit' as const,
    capturedAt: AT,
    sessionId: 'CANARY-SESSION-/Users/private/repo',
    eventId: 'CANARY-EVENT-provider-record',
  },
];

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

class FakeConsumer {
  private readonly accepted = new Map<
    string,
    { through: number; operations: Map<number, string> }
  >();

  accept(batch: SyncBatchV1): { acceptedThrough: number; conflict?: number } {
    const key = `${batch.streamId}:${batch.lane}`;
    const state = this.accepted.get(key) ?? { through: -1, operations: new Map<number, string>() };
    for (const operation of batch.operations) {
      const prior = state.operations.get(operation.position);
      if (prior && prior !== operation.contentDigest)
        return { acceptedThrough: state.through, conflict: operation.position };
      if (operation.position > state.through + 1) return { acceptedThrough: state.through };
      if (!verifySyncOperationDigest(operation))
        return { acceptedThrough: state.through, conflict: operation.position };
      state.operations.set(operation.position, operation.contentDigest);
      state.through = Math.max(state.through, operation.position);
    }
    this.accepted.set(key, state);
    return { acceptedThrough: state.through };
  }
}

describe('durable minimized sync outbox', () => {
  it('migrates schema 5 to empty disabled sync tables without rewriting existing metadata', () => {
    const { path, outbox } = open();
    outbox.close();
    const old = new DatabaseSync(path);
    old.exec('PRAGMA foreign_keys = OFF');
    old.exec(`
      DROP TABLE sync_deletion_receipts;
      DROP TABLE sync_outbox;
      DROP TABLE intelligence_tombstones;
      DROP TABLE intelligence_evidence_map;
      DROP TABLE intelligence_records;
      DROP TABLE sync_consent_revisions;
      DROP TABLE sync_streams;
      DROP TABLE sync_identity;
    `);
    old.prepare("UPDATE meta SET value='5' WHERE key='schema_version'").run();
    old.prepare("INSERT INTO meta (key, value) VALUES ('phase0_test_marker', 'preserved')").run();
    old.close();

    new SqliteStore(path).close();
    const migrated = new DatabaseSync(path, { readOnly: true });
    expect(migrated.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({
      value: '6',
    });
    expect(migrated.prepare("SELECT value FROM meta WHERE key='phase0_test_marker'").get()).toEqual(
      { value: 'preserved' },
    );
    for (const table of [
      'sync_streams',
      'sync_consent_revisions',
      'intelligence_records',
      'sync_outbox',
    ]) {
      expect(
        (migrated.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
          .count,
      ).toBe(0);
    }
    migrated.close();
  });

  it('keeps local evidence identifiers and paths out of committed batches', () => {
    const { outbox, stream } = open();
    outbox.grantConsent(stream.streamId, grant());
    const item = capture(outbox, stream.streamId);
    const json = JSON.stringify(outbox.nextBatch(stream.streamId, 'data'));
    expect(json).toContain(item.itemId);
    expect(json).not.toContain('CANARY-SESSION');
    expect(json).not.toContain('CANARY-EVENT');
    expect(json).not.toContain('/Users/private/repo');
    expect(json).not.toContain('transcriptPath');
    expect(json).not.toContain(SECRET_CANARY);
    expect(json).toContain('ghp_[GITHUB_TOKEN]');
    expect(json).not.toContain('GITHUB_TOKEN#1');
    outbox.close();
  });

  it('survives restart and lost acknowledgements without changing the operation', () => {
    const { path, outbox, stream } = open();
    outbox.grantConsent(stream.streamId, grant());
    capture(outbox, stream.streamId);
    const before = required(outbox.nextBatch(stream.streamId, 'data'), 'missing data batch');
    outbox.close();
    const reopened = new SqliteSyncOutbox(path);
    expect(reopened.nextBatch(stream.streamId, 'data')).toEqual(before);
    const consumer = new FakeConsumer();
    expect(consumer.accept(before).acceptedThrough).toBe(0);
    expect(consumer.accept(before).acceptedThrough).toBe(0);
    reopened.acknowledge({
      contract: 'salidium.sync-ack',
      contractVersion: 1,
      streamId: stream.streamId,
      lane: 'data',
      acceptedThrough: 0,
    });
    expect(reopened.nextBatch(stream.streamId, 'data')).toBeUndefined();
    reopened.close();
  });

  it('makes same-position content conflicts observable and rejects cursor-ahead acknowledgements', () => {
    const { outbox, stream } = open();
    outbox.grantConsent(stream.streamId, grant());
    capture(outbox, stream.streamId);
    const batch = required(outbox.nextBatch(stream.streamId, 'data'), 'missing data batch');
    const consumer = new FakeConsumer();
    expect(consumer.accept(batch)).toEqual({ acceptedThrough: 0 });
    const conflict = structuredClone(batch);
    required(conflict.operations[0], 'missing first operation').contentDigest =
      `sha256:${'f'.repeat(64)}`;
    expect(consumer.accept(conflict)).toEqual({ acceptedThrough: 0, conflict: 0 });
    expect(() =>
      outbox.acknowledge({
        contract: 'salidium.sync-ack',
        contractVersion: 1,
        streamId: stream.streamId,
        lane: 'data',
        acceptedThrough: 1,
      }),
    ).toThrow(/ahead/);
    outbox.close();
  });

  it('queues revocation and deletion on the control lane before pending decision data', () => {
    const { outbox, stream } = open();
    outbox.grantConsent(stream.streamId, grant());
    capture(outbox, stream.streamId);
    outbox.revokeConsent(stream.streamId, GRANT, new Date('2026-08-20T12:00:00.000Z'));
    expect(outbox.nextBatch(stream.streamId, 'control')?.operations.map((op) => op.type)).toEqual([
      'consent.put',
      'consent.revoke',
      'scope.delete',
    ]);
    expect(outbox.nextBatch(stream.streamId, 'data')?.operations.map((op) => op.type)).toEqual([
      'item.put',
    ]);
    expect(() => capture(outbox, stream.streamId)).toThrow(/stale|revoked/);
    outbox.close();
  });

  it('tracks corrections, tombstones, and deletion completion as distinct lifecycle facts', () => {
    const { outbox, stream } = open();
    outbox.grantConsent(stream.streamId, grant());
    const first = capture(outbox, stream.streamId);
    const second = outbox.reviseDecision(stream.streamId, first.itemId, {
      relation: 'corrects',
      capturedAt: '2026-08-20T12:00:00.000Z',
      retentionExpiresAt: EXPIRES,
      sensitivity: 'internal',
      evidence: EVIDENCE,
      selected: 'Use a minimized public contract and durable local outbox.',
      rationale: 'This distinguishes the interface from its private sender implementation.',
      alternatives: [
        {
          label: 'Reuse protocol events',
          disposition: 'rejected',
          rationale: 'Unsafe and over-coupled.',
        },
      ],
    });
    expect(second.revision).toBe(2);
    expect(second.links.at(-1)?.relation).toBe('corrects');
    expect(outbox.deleteItem(stream.streamId, first.itemId)).toBe(true);
    expect(outbox.inventory(stream.streamId)).toEqual({
      live: [],
      tombstones: [{ itemId: first.itemId, deleteThroughRevision: 2 }],
    });
    const deletion = required(
      outbox
        .nextBatch(stream.streamId, 'control')
        ?.operations.find((operation) => operation.type === 'item.delete'),
      'missing deletion operation',
    );
    expect(() =>
      outbox.recordDeletionReceipt({
        contract: 'salidium.deletion-receipt',
        contractVersion: 1,
        receiptId: '20000000-0000-4000-8000-000000000005',
        destinationId: '20000000-0000-4000-8000-000000000099',
        operationId: deletion.operationId,
        target: { kind: 'item', itemId: first.itemId, deleteThroughRevision: 2 },
        completedAt: '2026-08-21T12:00:00.000Z',
        sinks: ['ledger', 'projection', 'search', 'embedding', 'cache', 'backup-fence'],
      }),
    ).toThrow(/destination/);
    outbox.recordDeletionReceipt({
      contract: 'salidium.deletion-receipt',
      contractVersion: 1,
      receiptId: '20000000-0000-4000-8000-000000000004',
      destinationId: DESTINATION,
      operationId: deletion.operationId,
      target: { kind: 'item', itemId: first.itemId, deleteThroughRevision: 2 },
      completedAt: '2026-08-21T12:00:00.000Z',
      sinks: ['ledger', 'projection', 'search', 'embedding', 'cache', 'backup-fence'],
    });
    outbox.close();
  });

  it('refuses to invent the user attribution a decision needs', () => {
    const { outbox, stream } = open();
    outbox.grantConsent(stream.streamId, grant());
    expect(() =>
      outbox.captureDecision(stream.streamId, {
        grant: { grantId: GRANT, revision: 1 },
        capturedAt: AT,
        retentionExpiresAt: EXPIRES,
        sensitivity: 'internal',
        selected: 'A choice nobody made.',
        rationale: 'No evidence was supplied.',
        alternatives: [{ label: 'Alt', disposition: 'rejected', rationale: 'Fixture.' }],
        evidence: [],
      }),
    ).toThrow(/explicit evidence/);
    // The contract requires user-explicit evidence, so an agent-only decision cannot be laundered
    // into one by omitting the field and letting the producer fill it in.
    expect(() =>
      outbox.captureDecision(stream.streamId, {
        grant: { grantId: GRANT, revision: 1 },
        capturedAt: AT,
        retentionExpiresAt: EXPIRES,
        sensitivity: 'internal',
        selected: 'The agent decided.',
        rationale: 'Model output only.',
        alternatives: [{ label: 'Alt', disposition: 'rejected', rationale: 'Fixture.' }],
        evidence: [{ authority: 'model', capturedAt: AT }],
      }),
    ).toThrow();
    outbox.close();
  });

  it('enforces sensitivity, retention, and the decision-only Phase 0 consent boundary', () => {
    const { outbox, stream } = open();
    expect(() =>
      outbox.grantConsent(stream.streamId, grant({ allowedKinds: ['decision', 'claim'] })),
    ).toThrow(/decision records only/);
    outbox.grantConsent(stream.streamId, grant());
    expect(() =>
      outbox.captureDecision(stream.streamId, {
        grant: { grantId: GRANT, revision: 1 },
        capturedAt: AT,
        retentionExpiresAt: '2027-01-01T00:00:00.000Z',
        sensitivity: 'restricted',
        selected: 'Unsafe',
        rationale: 'Outside consent.',
        alternatives: [{ label: 'Safe', disposition: 'rejected', rationale: 'Fixture.' }],
        evidence: EVIDENCE,
      }),
    ).toThrow(/sensitivity|retention/);
    outbox.close();
  });
});
