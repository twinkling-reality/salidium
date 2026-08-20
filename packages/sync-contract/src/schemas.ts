import { z } from 'zod';

export const INTELLIGENCE_ITEM_CONTRACT = 'salidium.intelligence-item' as const;
export const CONSENT_GRANT_CONTRACT = 'salidium.consent-grant' as const;
export const SYNC_OPERATION_CONTRACT = 'salidium.sync-operation' as const;
export const SYNC_WIRE_VERSION = 1 as const;

export const CanonicalTimestampSchema = z.iso.datetime({ offset: false, precision: 3 });
export const OpaqueIdSchema = z.uuid();
export const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const PolicyVersionSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

export const SensitivitySchema = z.enum(['public', 'internal', 'confidential', 'restricted']);
export type Sensitivity = z.infer<typeof SensitivitySchema>;

export const IntelligenceKindSchema = z.enum([
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
export type IntelligenceKind = z.infer<typeof IntelligenceKindSchema>;

export const MemoryLayerSchema = z.enum([
  'working',
  'episodic',
  'semantic',
  'decision',
  'procedural',
  'preference',
]);
export const DurableMemoryLayerSchema = z.enum([
  'episodic',
  'semantic',
  'decision',
  'procedural',
  'preference',
]);

export const PersonalScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('personal') }),
  z.strictObject({ kind: z.literal('project'), projectId: OpaqueIdSchema }),
]);
export type PersonalScope = z.infer<typeof PersonalScopeSchema>;

export const ItemRevisionRefSchema = z.strictObject({
  itemId: OpaqueIdSchema,
  revision: z.number().int().positive(),
});
export type ItemRevisionRef = z.infer<typeof ItemRevisionRefSchema>;

const MethodSchema = z.strictObject({
  id: z.string().min(1).max(80),
  version: PolicyVersionSchema,
});

export const AssessmentSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('verification'),
    state: z.enum(['verified', 'unverified', 'disputed', 'unknown']),
    method: MethodSchema.optional(),
  }),
  z.strictObject({
    mode: z.literal('confidence'),
    probability: z.number().min(0).max(1),
    method: MethodSchema,
    calibratedAt: CanonicalTimestampSchema.optional(),
  }),
]);
export type Assessment = z.infer<typeof AssessmentSchema>;

/**
 * An opaque handle to evidence the receiver cannot see, plus the few properties it must reason
 * about: who is behind it, what it does for the item, when it was captured, and which other
 * references share a source so repetition cannot read as corroboration.
 *
 * There is deliberately no digest here. An earlier revision carried one, computed over exactly the
 * other fields of this object, so any receiver could recompute it from the record it accompanied.
 * It authenticated nothing and verified nothing, while looking like it did both, and the operation's
 * own `contentDigest` already covers these fields against tampering in transit.
 *
 * There is also deliberately no scope, sensitivity, or expiry. A receiver cannot verify a claim
 * about evidence it will never hold, so carrying producer-asserted copies would turn an
 * unverifiable assertion into something that reads as a checked constraint.
 */
export const EvidenceReferenceSchema = z.strictObject({
  evidenceId: OpaqueIdSchema,
  role: z.enum(['supports', 'contradicts', 'corrects', 'outcome']),
  authority: z.enum(['user-explicit', 'provider-record', 'salidium-rule', 'model']),
  capturedAt: CanonicalTimestampSchema,
  independenceId: OpaqueIdSchema,
});
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;

export const ItemLinkSchema = z.strictObject({
  relation: z.enum([
    'supports',
    'contradicts',
    'corrects',
    'supersedes',
    'outcome-of',
    'about',
    'derived-from',
  ]),
  target: ItemRevisionRefSchema,
});

const RetentionSchema = z.strictObject({
  policyId: PolicyVersionSchema,
  expiresAt: CanonicalTimestampSchema,
  deleteWithEvidence: z.literal(true),
});

const LifecycleSchema = z.strictObject({
  state: z.enum(['active', 'disputed', 'superseded', 'corrected', 'retracted', 'expired']),
  validFrom: CanonicalTimestampSchema,
  validUntil: CanonicalTimestampSchema.optional(),
  retention: RetentionSchema,
});

const CommonItemShape = {
  contract: z.literal(INTELLIGENCE_ITEM_CONTRACT),
  contractVersion: z.literal(SYNC_WIRE_VERSION),
  itemId: OpaqueIdSchema,
  originReplicaId: OpaqueIdSchema,
  revision: z.number().int().positive(),
  scope: PersonalScopeSchema,
  capturedAt: CanonicalTimestampSchema,
  effectiveFrom: CanonicalTimestampSchema,
  effectiveUntil: CanonicalTimestampSchema.optional(),
  epistemic: z.enum([
    'observed',
    'reported',
    'planned',
    'deterministic-inference',
    'probabilistic-inference',
  ]),
  assessment: AssessmentSchema,
  sensitivity: SensitivitySchema,
  lifecycle: LifecycleSchema,
  consent: z.strictObject({
    grantId: OpaqueIdSchema,
    revision: z.number().int().positive(),
  }),
  evidence: z.array(EvidenceReferenceSchema).min(1).max(32),
  links: z.array(ItemLinkSchema).max(64).default([]),
  redactionPolicyVersion: PolicyVersionSchema,
  minimizationPolicyVersion: PolicyVersionSchema,
} as const;

/*
 * Contract text is inert data that a receiver will render in a card and feed to search and
 * embedding sinks. Control characters, bidi overrides, and zero-width characters exist to make
 * rendered text differ from stored text, which is how a reviewed decision becomes an instruction
 * the reviewer never saw. Tab, newline, and carriage return survive because people type them.
 * Rejecting rather than stripping keeps the digest over exactly what the producer sent.
 */
const INERT_TEXT = new RegExp(
  '^[^' +
    '\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F' + // C0/C1 controls
    '\\u200B-\\u200F\\u2028\\u2029\\u202A-\\u202E' + // zero-width, separators, bidi embedding
    '\\u2060-\\u2064\\u2066-\\u2069\\uFEFF' + // invisible operators, bidi isolates, BOM
    ']*$',
  'u',
);
const INERT_TEXT_MESSAGE = 'text may not contain control, bidi, or zero-width characters';

const Text = z.string().min(1).max(2_000).regex(INERT_TEXT, INERT_TEXT_MESSAGE);
const ShortText = z.string().min(1).max(300).regex(INERT_TEXT, INERT_TEXT_MESSAGE);

const ObservationItemSchema = z.strictObject({
  ...CommonItemShape,
  kind: z.literal('observation'),
  statement: Text,
});

const ClaimItemSchema = z.strictObject({
  ...CommonItemShape,
  kind: z.literal('claim'),
  claimant: z.enum(['authenticated-user', 'agent', 'external']),
  statement: Text,
});

const DecisionAlternativeSchema = z.strictObject({
  label: ShortText,
  disposition: z.enum(['rejected', 'deferred', 'unknown']),
  rationale: Text,
});

export const DecisionItemSchema = z.strictObject({
  ...CommonItemShape,
  kind: z.literal('decision'),
  question: Text.optional(),
  selected: Text,
  rationale: Text,
  owner: z.literal('authenticated-user'),
  status: z.enum(['active', 'fulfilled', 'abandoned', 'superseded']),
  alternatives: z.array(DecisionAlternativeSchema).min(1).max(12),
});
export type DecisionItem = z.infer<typeof DecisionItemSchema>;

const IntentionItemSchema = z.strictObject({
  ...CommonItemShape,
  kind: z.literal('intention'),
  actor: z.enum(['authenticated-user', 'agent']),
  description: Text,
  status: z.enum(['active', 'fulfilled', 'abandoned', 'expired']),
});

const CommitmentItemSchema = z.strictObject({
  ...CommonItemShape,
  kind: z.literal('commitment'),
  actor: z.literal('authenticated-user'),
  description: Text,
  status: z.enum(['active', 'fulfilled', 'abandoned', 'expired']),
  dueAt: CanonicalTimestampSchema.optional(),
});

const OutcomeItemSchema = z.strictObject({
  ...CommonItemShape,
  kind: z.literal('outcome'),
  description: Text,
  result: z.enum(['positive', 'negative', 'mixed', 'unknown']),
});

const EntityItemSchema = z.strictObject({
  ...CommonItemShape,
  kind: z.literal('entity'),
  entityType: z.enum([
    'project',
    'component',
    'dependency',
    'person',
    'team',
    'environment',
    'concept',
  ]),
  name: ShortText,
  aliases: z.array(ShortText).max(12).default([]),
});

const RelationshipItemSchema = z.strictObject({
  ...CommonItemShape,
  kind: z.literal('relationship'),
  subject: ItemRevisionRefSchema,
  predicate: ShortText,
  object: ItemRevisionRefSchema,
});

const ExplicitPreferenceItemSchema = z.strictObject({
  ...CommonItemShape,
  kind: z.literal('preference.explicit'),
  owner: z.literal('authenticated-user'),
  key: ShortText,
  value: Text,
});

const InferredPreferenceItemSchema = z.strictObject({
  ...CommonItemShape,
  kind: z.literal('preference.inferred'),
  owner: z.literal('authenticated-user'),
  key: ShortText,
  value: Text,
});

const MemoryItemSchema = z.strictObject({
  ...CommonItemShape,
  kind: z.literal('memory'),
  layer: DurableMemoryLayerSchema,
  summary: Text,
  promotionPolicyVersion: PolicyVersionSchema,
});

const InferenceItemSchema = z.strictObject({
  ...CommonItemShape,
  kind: z.literal('inference'),
  proposition: Text,
});

export const IntelligenceItemV1Schema = z
  .discriminatedUnion('kind', [
    ObservationItemSchema,
    ClaimItemSchema,
    DecisionItemSchema,
    IntentionItemSchema,
    CommitmentItemSchema,
    OutcomeItemSchema,
    EntityItemSchema,
    RelationshipItemSchema,
    ExplicitPreferenceItemSchema,
    InferredPreferenceItemSchema,
    MemoryItemSchema,
    InferenceItemSchema,
  ])
  .superRefine((item, ctx) => {
    const probabilistic = item.kind === 'inference' || item.kind === 'preference.inferred';
    if (probabilistic && item.assessment.mode !== 'confidence') {
      ctx.addIssue({
        code: 'custom',
        path: ['assessment'],
        message: 'probabilistic items require calibrated confidence',
      });
    }
    if (probabilistic && item.epistemic !== 'probabilistic-inference') {
      ctx.addIssue({
        code: 'custom',
        path: ['epistemic'],
        message: 'probabilistic items must remain explicitly inferred',
      });
    }
    if (item.kind === 'claim' && item.epistemic !== 'reported') {
      ctx.addIssue({ code: 'custom', path: ['epistemic'], message: 'claims must remain reported' });
    }
    if (item.kind === 'observation' && item.epistemic !== 'observed') {
      ctx.addIssue({
        code: 'custom',
        path: ['epistemic'],
        message: 'observations must remain observed',
      });
    }
    if (item.effectiveUntil && item.effectiveUntil < item.effectiveFrom) {
      ctx.addIssue({
        code: 'custom',
        path: ['effectiveUntil'],
        message: 'effective interval ends before it begins',
      });
    }
    if (item.lifecycle.validUntil && item.lifecycle.validUntil < item.lifecycle.validFrom) {
      ctx.addIssue({
        code: 'custom',
        path: ['lifecycle', 'validUntil'],
        message: 'valid interval ends before it begins',
      });
    }
    if (item.lifecycle.retention.expiresAt <= item.capturedAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['lifecycle', 'retention', 'expiresAt'],
        message: 'retention must end after capture',
      });
    }
    if (item.kind === 'decision') {
      if (item.epistemic !== 'reported') {
        ctx.addIssue({
          code: 'custom',
          path: ['epistemic'],
          message: 'decisions must remain reported',
        });
      }
      if (item.assessment.mode !== 'verification' || item.assessment.state !== 'verified') {
        ctx.addIssue({
          code: 'custom',
          path: ['assessment'],
          message: 'decisions require explicit verification',
        });
      }
      if (!item.evidence.some((evidence) => evidence.authority === 'user-explicit')) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence'],
          message: 'decisions require explicit user evidence',
        });
      }
    }
    /*
     * Model output is never authority. Guarding by `kind` alone left the durable layer of a memory
     * unchecked, so an all-model `memory` with `layer: 'decision'` asserted what a `decision` may
     * not. The rule is therefore stated three ways: the kinds that assert a fact about the world,
     * the kinds that put words in the authenticated user's mouth, and the epistemic status any item
     * may claim. `inference` and `preference.inferred` are deliberately absent because they are
     * required to stay labelled as probabilistic and never present themselves as established.
     */
    const modelOnly = item.evidence.every((evidence) => evidence.authority === 'model');
    if (modelOnly) {
      const assertsFact =
        item.kind === 'observation' ||
        item.kind === 'decision' ||
        item.kind === 'preference.explicit' ||
        (item.kind === 'memory' && item.layer !== 'episodic');
      const attributedToUser =
        (item.kind === 'commitment' && item.actor === 'authenticated-user') ||
        (item.kind === 'intention' && item.actor === 'authenticated-user') ||
        (item.kind === 'claim' && item.claimant === 'authenticated-user');
      if (assertsFact || attributedToUser) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence'],
          message: 'model output alone cannot support this durable item',
        });
      }
      if (item.epistemic === 'observed') {
        ctx.addIssue({
          code: 'custom',
          path: ['epistemic'],
          message: 'model output alone cannot establish an observation',
        });
      }
      if (item.assessment.mode === 'verification' && item.assessment.state === 'verified') {
        ctx.addIssue({
          code: 'custom',
          path: ['assessment'],
          message: 'model output alone cannot establish verification',
        });
      }
    }
    if (item.kind === 'memory' && !item.links.some((link) => link.relation === 'derived-from')) {
      /*
       * A memory is promoted material, so it has to say what it was promoted from. Without that
       * link, deleting the record a memory was built on cannot find the memory, and the deletion
       * lineage the retention model promises stops at the item boundary.
       */
      ctx.addIssue({
        code: 'custom',
        path: ['links'],
        message: 'durable memory requires a derived-from link to what it was promoted from',
      });
    }
    if (item.kind === 'outcome' && !item.links.some((link) => link.relation === 'outcome-of')) {
      ctx.addIssue({
        code: 'custom',
        path: ['links'],
        message: 'outcomes require an outcome-of link',
      });
    }
  });
export type IntelligenceItemV1 = z.infer<typeof IntelligenceItemV1Schema>;

export const ConsentGrantV1Schema = z
  .strictObject({
    contract: z.literal(CONSENT_GRANT_CONTRACT),
    contractVersion: z.literal(SYNC_WIRE_VERSION),
    grantId: OpaqueIdSchema,
    revision: z.number().int().positive(),
    destinationId: OpaqueIdSchema,
    scope: PersonalScopeSchema,
    purpose: z.literal('personal-continuity'),
    allowedKinds: z.array(IntelligenceKindSchema).min(1).max(IntelligenceKindSchema.options.length),
    maximumSensitivity: SensitivitySchema,
    issuedAt: CanonicalTimestampSchema,
    effectiveAt: CanonicalTimestampSchema,
    expiresAt: CanonicalTimestampSchema,
    retentionMaximumDays: z.number().int().min(1).max(365),
    redactionPolicyVersion: PolicyVersionSchema,
    minimizationPolicyVersion: PolicyVersionSchema,
    rawEvidence: z.literal(false),
    status: z.enum(['active', 'revoked']),
    revokedAt: CanonicalTimestampSchema.optional(),
  })
  .superRefine((grant, ctx) => {
    if (new Set(grant.allowedKinds).size !== grant.allowedKinds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowedKinds'],
        message: 'allowed kinds must be unique',
      });
    }
    if (grant.expiresAt <= grant.effectiveAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'grant must expire after it becomes effective',
      });
    }
    if (grant.effectiveAt < grant.issuedAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['effectiveAt'],
        message: 'grant cannot become effective before issuance',
      });
    }
    if (grant.revokedAt && grant.revokedAt < grant.issuedAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['revokedAt'],
        message: 'grant cannot be revoked before issuance',
      });
    }
    if ((grant.status === 'revoked') !== (grant.revokedAt !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['revokedAt'],
        message: 'revoked grants require revokedAt and active grants forbid it',
      });
    }
  });
export type ConsentGrantV1 = z.infer<typeof ConsentGrantV1Schema>;

export const ConsentReferenceSchema = z.strictObject({
  grantId: OpaqueIdSchema,
  revision: z.number().int().positive(),
});

export const DeletionReasonSchema = z.enum([
  'user-request',
  'consent-withdrawn',
  'retention-expired',
  'corrected',
  'scope-deleted',
]);
