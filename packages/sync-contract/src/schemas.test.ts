import { describe, expect, it } from 'vitest';
import {
  CONSENT_GRANT_CONTRACT,
  type ConsentGrantV1,
  ConsentGrantV1Schema,
  INTELLIGENCE_ITEM_CONTRACT,
  IntelligenceItemV1Schema,
  MemoryLayerSchema,
  SYNC_WIRE_VERSION,
} from './schemas.ts';
import {
  assertSendableBatch,
  digestCanonical,
  SyncAckV1Schema,
  SyncBatchV1Schema,
  SyncOperationV1Schema,
  sealSyncOperation,
  verifySyncOperationDigest,
} from './wire.ts';

const IDS = {
  item: '10000000-0000-4000-8000-000000000001',
  replica: '10000000-0000-4000-8000-000000000002',
  grant: '10000000-0000-4000-8000-000000000003',
  destination: '10000000-0000-4000-8000-000000000004',
  evidence: '10000000-0000-4000-8000-000000000005',
  independence: '10000000-0000-4000-8000-000000000006',
  project: '10000000-0000-4000-8000-000000000007',
  stream: '10000000-0000-4000-8000-000000000008',
  operation: '10000000-0000-4000-8000-000000000009',
  prior: '10000000-0000-4000-8000-000000000010',
  other: '10000000-0000-4000-8000-000000000011',
} as const;

const AT = '2026-08-19T12:00:00.000Z';
const LATER = '2026-09-18T12:00:00.000Z';

function common(kind: string) {
  return {
    contract: INTELLIGENCE_ITEM_CONTRACT,
    contractVersion: SYNC_WIRE_VERSION,
    itemId: IDS.item,
    originReplicaId: IDS.replica,
    revision: 1,
    kind,
    scope: { kind: 'project', projectId: IDS.project },
    capturedAt: AT,
    effectiveFrom: AT,
    epistemic: 'reported',
    assessment: {
      mode: 'verification',
      state: 'verified',
      method: { id: 'user-confirmation', version: '1' },
    },
    sensitivity: 'internal',
    lifecycle: {
      state: 'active',
      validFrom: AT,
      retention: { policyId: 'phase0-30d', expiresAt: LATER, deleteWithEvidence: true },
    },
    consent: { grantId: IDS.grant, revision: 1 },
    evidence: [
      {
        evidenceId: IDS.evidence,
        role: 'supports',
        authority: 'user-explicit',
        capturedAt: AT,
        independenceId: IDS.independence,
        exportDigest: `sha256:${'a'.repeat(64)}`,
      },
    ],
    links: [],
    redactionPolicyVersion: 'secrets-v1',
    minimizationPolicyVersion: 'decision-v1',
  };
}

function decision() {
  return {
    ...common('decision'),
    selected: 'Keep raw provider evidence local.',
    rationale: 'Local evidence remains inspectable without broadening the hosted trust boundary.',
    owner: 'authenticated-user',
    status: 'active',
    alternatives: [
      {
        label: 'Upload canonical events',
        disposition: 'rejected',
        rationale: 'Canonical events contain paths, prompts, commands, and output excerpts.',
      },
    ],
  };
}

function grant(overrides: Partial<ConsentGrantV1> = {}): ConsentGrantV1 {
  return ConsentGrantV1Schema.parse({
    contract: CONSENT_GRANT_CONTRACT,
    contractVersion: SYNC_WIRE_VERSION,
    grantId: IDS.grant,
    revision: 1,
    destinationId: IDS.destination,
    scope: { kind: 'project', projectId: IDS.project },
    purpose: 'personal-continuity',
    allowedKinds: ['decision'],
    maximumSensitivity: 'internal',
    issuedAt: AT,
    effectiveAt: AT,
    expiresAt: LATER,
    retentionMaximumDays: 30,
    redactionPolicyVersion: 'secrets-v1',
    minimizationPolicyVersion: 'decision-v1',
    rawEvidence: false,
    status: 'active',
    ...overrides,
  });
}

describe('intelligence item v1', () => {
  it('distinguishes every required durable kind and keeps working memory local', () => {
    const variants = [
      {
        ...common('observation'),
        epistemic: 'observed',
        statement: 'The check exited with code 0.',
      },
      { ...common('claim'), claimant: 'agent', statement: 'The agent says the migration is safe.' },
      decision(),
      {
        ...common('intention'),
        epistemic: 'planned',
        actor: 'agent',
        description: 'Investigate replay.',
        status: 'active',
      },
      {
        ...common('commitment'),
        epistemic: 'planned',
        actor: 'authenticated-user',
        description: 'Review deletion receipts.',
        status: 'active',
      },
      {
        ...common('outcome'),
        epistemic: 'observed',
        description: 'The restore retained the deletion fence.',
        result: 'positive',
        links: [{ relation: 'outcome-of', target: { itemId: IDS.other, revision: 1 } }],
      },
      { ...common('entity'), entityType: 'project', name: 'Synthetic project', aliases: [] },
      {
        ...common('relationship'),
        subject: { itemId: IDS.item, revision: 1 },
        predicate: 'depends-on',
        object: { itemId: IDS.other, revision: 1 },
      },
      {
        ...common('preference.explicit'),
        owner: 'authenticated-user',
        key: 'review.mode',
        value: 'evidence-first',
      },
      {
        ...common('preference.inferred'),
        epistemic: 'probabilistic-inference',
        assessment: {
          mode: 'confidence',
          probability: 0.61,
          method: { id: 'preference-model', version: '1' },
        },
        owner: 'authenticated-user',
        key: 'review.mode',
        value: 'evidence-first',
      },
      {
        ...common('memory'),
        layer: 'episodic',
        summary: 'A bounded incident episode.',
        promotionPolicyVersion: 'episode-v1',
      },
      {
        ...common('inference'),
        epistemic: 'probabilistic-inference',
        assessment: {
          mode: 'confidence',
          probability: 0.52,
          method: { id: 'inference-model', version: '1' },
        },
        proposition: 'The old assumption may be stale.',
      },
    ];

    expect(variants.map((value) => IntelligenceItemV1Schema.parse(value).kind)).toEqual([
      'observation',
      'claim',
      'decision',
      'intention',
      'commitment',
      'outcome',
      'entity',
      'relationship',
      'preference.explicit',
      'preference.inferred',
      'memory',
      'inference',
    ]);
    expect(MemoryLayerSchema.parse('working')).toBe('working');
    expect(() =>
      IntelligenceItemV1Schema.parse({
        ...common('memory'),
        layer: 'working',
        summary: 'temporary',
        promotionPolicyVersion: 'v1',
      }),
    ).toThrow();
  });

  it('keeps classifier confidence separate from factual probability', () => {
    expect(() =>
      IntelligenceItemV1Schema.parse({
        ...common('inference'),
        epistemic: 'probabilistic-inference',
        assessment: { mode: 'verification', state: 'verified' },
        proposition: 'A probabilistic proposition',
      }),
    ).toThrow(/calibrated confidence/);
  });

  it('forbids model-only promotion to decisions, observations, explicit preferences, or procedures', () => {
    const evidence = [{ ...common('decision').evidence[0], authority: 'model' }];
    for (const value of [
      { ...decision(), evidence },
      { ...common('observation'), epistemic: 'observed', statement: 'Observed', evidence },
      {
        ...common('preference.explicit'),
        owner: 'authenticated-user',
        key: 'x',
        value: 'y',
        evidence,
      },
      {
        ...common('memory'),
        layer: 'procedural',
        summary: 'Run this',
        promotionPolicyVersion: 'v1',
        evidence,
      },
    ]) {
      expect(() => IntelligenceItemV1Schema.parse(value)).toThrow(/model output alone/);
    }
  });

  it('forbids model-only promotion through the durable memory layer and user attribution', () => {
    const evidence = [{ ...common('decision').evidence[0], authority: 'model' }];
    const memory = (layer: string) => ({
      ...common('memory'),
      // A model-summarized episode is honest only while it stays unverified.
      assessment: { mode: 'verification', state: 'unverified' },
      layer,
      summary: 'A durable assertion.',
      promotionPolicyVersion: 'v1',
      links: [{ relation: 'derived-from', target: { itemId: IDS.other, revision: 1 } }],
      evidence,
    });
    // Guarding on `kind` alone let a memory assert at a layer its own kind may not.
    for (const layer of ['semantic', 'decision', 'procedural', 'preference']) {
      expect(() => IntelligenceItemV1Schema.parse(memory(layer))).toThrow(/model output alone/);
    }
    // An episode is a bounded record of what happened and may be summarized.
    expect(IntelligenceItemV1Schema.parse(memory('episodic')).kind).toBe('memory');

    for (const value of [
      {
        ...common('commitment'),
        epistemic: 'planned',
        actor: 'authenticated-user',
        description: 'A duty the user never accepted.',
        status: 'active',
        evidence,
      },
      {
        ...common('intention'),
        epistemic: 'planned',
        actor: 'authenticated-user',
        description: 'A plan the user never stated.',
        status: 'active',
        evidence,
      },
      {
        ...common('claim'),
        claimant: 'authenticated-user',
        statement: 'Words the user never said.',
        evidence,
      },
    ]) {
      expect(() => IntelligenceItemV1Schema.parse(value)).toThrow(/model output alone/);
    }
    // An agent may be quoted; that is what a claim is for.
    expect(
      IntelligenceItemV1Schema.parse({
        ...common('claim'),
        assessment: { mode: 'verification', state: 'unverified' },
        claimant: 'agent',
        statement: 'The agent said the migration is safe.',
        evidence,
      }).kind,
    ).toBe('claim');
  });

  it('forbids model-only evidence from claiming observation or verification', () => {
    const evidence = [{ ...common('decision').evidence[0], authority: 'model' }];
    expect(() =>
      IntelligenceItemV1Schema.parse({
        ...common('inference'),
        epistemic: 'observed',
        assessment: { mode: 'confidence', probability: 0.5, method: { id: 'm', version: '1' } },
        proposition: 'Dressed as an observation.',
        evidence,
      }),
    ).toThrow(/cannot establish an observation/);
    expect(() =>
      IntelligenceItemV1Schema.parse({
        ...common('entity'),
        entityType: 'project',
        name: 'Verified by nobody',
        assessment: { mode: 'verification', state: 'verified' },
        evidence,
      }),
    ).toThrow(/cannot establish verification/);
  });

  it('requires an explicitly verified user decision rather than provider or model inference', () => {
    expect(() =>
      IntelligenceItemV1Schema.parse({
        ...decision(),
        evidence: [{ ...decision().evidence[0], authority: 'provider-record' }],
      }),
    ).toThrow(/explicit user evidence/);
    expect(() =>
      IntelligenceItemV1Schema.parse({
        ...decision(),
        assessment: { mode: 'verification', state: 'unverified' },
      }),
    ).toThrow(/explicit verification/);
  });

  it('rejects unknown local evidence and provider fields instead of stripping them', () => {
    expect(
      IntelligenceItemV1Schema.safeParse({
        ...decision(),
        transcriptPath: '/private/rollout.jsonl',
      }).success,
    ).toBe(false);
    expect(
      IntelligenceItemV1Schema.safeParse({
        ...decision(),
        evidence: [{ ...decision().evidence[0], source: { path: '/private/file', line: 2 } }],
      }).success,
    ).toBe(false);
  });
});

describe('consent and wire behavior', () => {
  it('requires bounded, explicit, non-raw consent', () => {
    expect(grant().rawEvidence).toBe(false);
    expect(ConsentGrantV1Schema.safeParse({ ...grant(), rawEvidence: true }).success).toBe(false);
    expect(
      ConsentGrantV1Schema.safeParse({ ...grant(), allowedKinds: ['decision', 'decision'] })
        .success,
    ).toBe(false);
  });

  it('seals and verifies operations without trusting a caller-provided digest', () => {
    const operation = sealSyncOperation({
      contract: 'salidium.sync-operation',
      contractVersion: 1,
      streamId: IDS.stream,
      replicaId: IDS.replica,
      lane: 'data',
      position: 0,
      operationId: IDS.operation,
      occurredAt: AT,
      type: 'item.put',
      grant: { grantId: IDS.grant, revision: 1 },
      item: decision(),
    });
    expect(verifySyncOperationDigest(operation)).toBe(true);
    const unsigned = { ...operation } as Partial<typeof operation>;
    delete unsigned.contentDigest;
    expect(operation.contentDigest).toBe(digestCanonical(unsigned));
    expect(() => sealSyncOperation({ ...operation })).toThrow(/must not contain contentDigest/);
  });

  it('requires contiguous, single-lane batches and rejects digest changes', () => {
    const first = sealSyncOperation({
      contract: 'salidium.sync-operation',
      contractVersion: 1,
      streamId: IDS.stream,
      replicaId: IDS.replica,
      lane: 'control',
      position: 0,
      operationId: IDS.operation,
      occurredAt: AT,
      type: 'consent.put',
      grant: grant(),
    });
    const batch = {
      contract: 'salidium.sync-batch',
      contractVersion: 1,
      streamId: IDS.stream,
      replicaId: IDS.replica,
      lane: 'control',
      afterPosition: -1,
      operations: [first],
    };
    expect(assertSendableBatch(batch).operations).toHaveLength(1);
    expect(SyncBatchV1Schema.safeParse({ ...batch, afterPosition: 0 }).success).toBe(false);
    expect(() =>
      assertSendableBatch({
        ...batch,
        operations: [{ ...first, occurredAt: '2026-08-19T12:00:01.000Z' }],
      }),
    ).toThrow(/invalid digest/);
  });

  it('digests the validated operation so an omitted default is not a content conflict', () => {
    /*
     * `links` carries a schema default. A producer that spells it out and a producer that leaves it
     * to the default are sending the same operation, and a receiver is required to treat one
     * position carrying two digests as a security conflict, so the two must digest identically.
     */
    const base = {
      contract: 'salidium.sync-operation',
      contractVersion: 1,
      streamId: IDS.stream,
      replicaId: IDS.replica,
      lane: 'data',
      position: 0,
      operationId: IDS.operation,
      occurredAt: AT,
      type: 'item.put',
      grant: { grantId: IDS.grant, revision: 1 },
    } as const;
    const { links: _spelledOut, ...withoutLinks } = decision();

    const omitted = sealSyncOperation({ ...base, item: withoutLinks });
    const explicit = sealSyncOperation({ ...base, item: { ...withoutLinks, links: [] } });

    expect(omitted.contentDigest).toBe(explicit.contentDigest);
    expect(verifySyncOperationDigest(omitted)).toBe(true);
    expect(
      verifySyncOperationDigest(SyncOperationV1Schema.parse(JSON.parse(JSON.stringify(omitted)))),
    ).toBe(true);
    expect(() =>
      assertSendableBatch({
        contract: 'salidium.sync-batch',
        contractVersion: 1,
        streamId: IDS.stream,
        replicaId: IDS.replica,
        lane: 'data',
        afterPosition: -1,
        operations: [omitted],
      }),
    ).not.toThrow();
  });

  it('does not confuse transport acknowledgement with deletion completion', () => {
    const ack = SyncAckV1Schema.parse({
      contract: 'salidium.sync-ack',
      contractVersion: 1,
      streamId: IDS.stream,
      lane: 'control',
      acceptedThrough: 2,
    });
    expect(ack).not.toHaveProperty('deleted');
  });
});
