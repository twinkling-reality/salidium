import { PROVIDER_ADAPTER_CONTRACT_VERSION, type ProviderDescriptor } from '@salidium/adapter-kit';
import { EventBuilder } from '@salidium/core/testing';
import type { CanonicalEvent, ProviderId, StoredEvent } from '@salidium/protocol';

/**
 * Synthetic sessions for the consumer contract's tests and retained fixtures.
 *
 * Every name, path, id, and timestamp here is invented. The events go through the real ingest,
 * redaction, reducer, and projection, so the documents a consumer sees are derived by the product
 * rather than written down.
 *
 * The canaries are planted in every place the contract must not carry: the prompt, a command line,
 * command output, the full final message, a subagent brief, and thinking. A test fails if any of
 * them appears in a consumer document. The secrets are planted in a sentence that does cross, to
 * prove the boundary redacts: one a vendor token any rule finds by its prefix, one a password with
 * no shape of its own, found only by the JSON key that names it.
 */
export const CONSUMER_CANARIES = {
  prompt: 'PROMPTCANARY',
  command: 'COMMANDCANARY',
  output: 'OUTPUTCANARY',
  finalMessage: 'FINALCANARY',
  subagentBrief: 'BRIEFCANARY',
} as const;

export const CONSUMER_SECRET = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`;
export const CONSUMER_JSON_SECRET = 'Zq8rL0xStaging';

export const SCENARIO_CLOCK = Date.parse('2026-09-20T16:20:00.000Z');

export const SCENARIO_SESSIONS = {
  verified: { provider: 'claude-code', sessionId: '6f1c2a90-3b7e-4d15-9a2c-0e8b5d7f4c11' },
  failing: { provider: 'codex', sessionId: '0199a3f2-7c4e-7b10-8d2a-5e6f9c1b3a47' },
  working: { provider: 'claude-code', sessionId: 'b27e5d10-8c4f-4a63-9e1d-3f5a7c9b2e84' },
  internal: { provider: 'claude-code', sessionId: '9d4e7b21-5a3c-4f80-b6e2-1c7a9f0d8e35' },
} as const;

const CWD = '/Users/dev/acme/checkout';
/** A linked worktree of CWD, where the agent wrote one file: the session's root does not hold it. */
const LANE = '/Users/dev/acme/checkout-refunds';
/** A scratch repository whose name holds the secret, so located paths prove the boundary redacts. */
const SCRATCH = `/Users/dev/scratch-${CONSUMER_SECRET}`;

const VITEST_PASS = `
 ✓ src/payments/ChargeService.test.ts (14 tests) 210ms
 Test Files  46 passed (46)
      Tests  118 passed (118)
   Duration  6.41s
 ${CONSUMER_CANARIES.output}
`;

const VITEST_FAIL = `
 ❯ src/images/resolveUrl.test.ts (7 tests | 3 failed) 212ms
 Test Files  1 failed | 45 passed (46)
      Tests  3 failed | 115 passed (118)
   Duration  6.02s
 ${CONSUMER_CANARIES.output}
`;

function withProvider(events: StoredEvent[], provider: 'claude-code' | 'codex'): CanonicalEvent[] {
  return events.map(({ seq: _seq, ...event }) => ({
    ...event,
    source: { ...event.source, provider },
  })) as CanonicalEvent[];
}

/** A finished Claude Code session: checks passed, then one more edit left a file unverified. */
function verifiedSession(): CanonicalEvent[] {
  const b = new EventBuilder(
    `claude-code:${SCENARIO_SESSIONS.verified.sessionId}`,
    '2026-09-20T15:40:00.000Z',
  );
  const started = b.sessionStarted(CWD, 'claude-opus-5');
  const events: StoredEvent[] = [
    {
      ...started,
      gitBranch: 'fix/double-charge',
      title: 'Fix double charge on retry',
    } as StoredEvent,
    b.raw({
      id: 'git:1',
      kind: 'git.snapshot',
      repoRoot: CWD,
      head: '3f9a2c1d8e7b6a5f4c3d2e1f0a9b8c7d6e5f4a3b',
      branch: 'fix/double-charge',
      dirty: [],
      trigger: 'session.started',
    } as never),
    b.turnStarted(`${CONSUMER_CANARIES.prompt} Customers are charged twice when checkout retries.`),
    b.message(
      'I will add an idempotency key in ChargeService so a retried charge returns the first one.',
    ),
    b.plan([
      { id: '1', text: 'Add an idempotency key to charges', status: 'completed' },
      { id: '2', text: 'Reuse the key in the retry worker', status: 'completed' },
      { id: '3', text: 'Document refund behaviour for support', status: 'pending' },
    ]),
    ...b.edit('c1', `${CWD}/src/payments/ChargeService.ts`, 24, 3),
    ...b.edit('c2', `${CWD}/src/checkout/RetryWorker.ts`, 8, 2),
    b.raw({
      id: 'subagent:reviewer:start',
      kind: 'subagent.started',
      subagentId: 'reviewer',
      agentType: 'code-reviewer',
      description: `${CONSUMER_CANARIES.subagentBrief} review the retry path`,
    } as never),
    // A subagent's edit. Its only "reason" in the interface is the delegation brief above, which is
    // a tool input and must not cross.
    ...b
      .edit('c2b', `${CWD}/src/payments/ChargeService.test.ts`, 6, 0)
      .map((event) => ({ ...event, agentId: 'reviewer' }) as StoredEvent),
    b.raw({ id: 'thinking:1', kind: 'agent.thinking', chars: 1200 } as never),
    ...b.command('c3', `pnpm test ${CONSUMER_CANARIES.command}`, VITEST_PASS, { exitCode: 0 }),
    b.message(
      `All tests pass. The staging key ${CONSUMER_SECRET} was never used by the fix, nor was {"password":"${CONSUMER_JSON_SECRET}"}.`,
    ),
    ...b.edit('c4', `${LANE}/src/payments/refunds.ts`, 5, 1),
    ...b.edit('c4b', `${SCRATCH}/notes.md`, 3, 0),
    // Where Salidium found each changed file, as its file locator reports it for a live session.
    b.raw({
      id: 'located:1',
      kind: 'file.located',
      files: [
        ...[
          'src/payments/ChargeService.ts',
          'src/checkout/RetryWorker.ts',
          'src/payments/ChargeService.test.ts',
        ].map((path) => ({ path: `${CWD}/${path}`, repository: { root: CWD, path } })),
        {
          path: `${LANE}/src/payments/refunds.ts`,
          repository: { root: LANE, path: 'src/payments/refunds.ts', mainRoot: CWD },
        },
        { path: `${SCRATCH}/notes.md`, repository: { root: SCRATCH, path: 'notes.md' } },
      ],
    } as never),
    // The destructive segment is the review finding and crosses; the rest of the line does not.
    ...b.command(
      'c5',
      `rm -rf node_modules/.cache && echo cleared ${CONSUMER_CANARIES.command}`,
      '',
      {
        exitCode: 0,
      },
    ),
  ];
  // The final message's opening line is the agent's report on the turn and crosses as a
  // statement; the body below it does not.
  events.push(
    b.turnEnded(
      `Fixed the double charge with one idempotency key per order.\n\n${CONSUMER_CANARIES.finalMessage} The retry worker now reads the key from the order row.`,
    ),
  );
  events.push(
    b.raw({
      id: 'git:2',
      kind: 'git.snapshot',
      repoRoot: CWD,
      head: '8b1e4d7a2c9f6b3e0d5a8c1f4b7e2d9a6c3f0b5e',
      // The agent switched to a branch whose name holds the secret; the anchor must not carry it.
      branch: `fix/${CONSUMER_SECRET}`,
      dirty: [],
      trigger: 'turn.ended',
    } as never),
  );
  events.push(b.sessionEnded());
  events.push(
    b.raw({
      id: `explanation:${events.length}`,
      kind: 'salidium.explanation',
      basedOnSeq: events.length - 1,
      model: 'claude-opus-5',
      what: {
        summary: 'Some customers were charged twice when checkout retried a payment.',
        currently: null,
      },
      why: {
        summary: 'Two paths could charge the same order, and neither checked the other.',
        lanes: [
          { title: 'Checkout request', steps: ['Times out, then retries', 'Creates a charge'] },
          { title: 'Retry worker', steps: ['Picks the same order up', 'Creates another charge'] },
        ],
        chain: ['Two charges for one order', 'The card is billed twice'],
      },
      how: {
        summary: 'One idempotency key per order, sent with every charge.',
        root: 'ChargeService.ts',
        steps: ['Derive a key per order', 'Send it with the charge', 'The worker reuses it'],
      },
      approachChange: null,
    } as never),
  );
  return withProvider(events, 'claude-code');
}

/** A Codex session still open: its tests fail and it is waiting for permission. */
function failingSession(): CanonicalEvent[] {
  const b = new EventBuilder(
    `codex:${SCENARIO_SESSIONS.failing.sessionId}`,
    '2026-09-20T16:05:00.000Z',
  );
  const events: StoredEvent[] = [
    b.sessionStarted('/Users/dev/acme/images', 'gpt-5.5-codex'),
    b.turnStarted(`${CONSUMER_CANARIES.prompt} Image URLs break behind the CDN.`),
    b.message('The resolver drops the CDN prefix when the path is already absolute.'),
    ...b.edit('k1', 'src/images/resolveUrl.ts', 12, 4),
    ...b.command('k2', `pnpm vitest run ${CONSUMER_CANARIES.command}`, VITEST_FAIL, {
      exitCode: 1,
    }),
    b.permission('shell', 'Run: git push origin fix/cdn-prefix'),
  ];
  return withProvider(events, 'codex');
}

/**
 * A Claude Code session mid-command with no narration yet. The interface reads its current state as
 * the command's title and the prompt ("Working on: ..."); neither may cross.
 */
function workingSession(): CanonicalEvent[] {
  const b = new EventBuilder(
    `claude-code:${SCENARIO_SESSIONS.working.sessionId}`,
    '2026-09-20T16:14:00.000Z',
  );
  const events: StoredEvent[] = [
    b.sessionStarted('/Users/dev/acme/search', 'claude-opus-5'),
    b.turnStarted(`${CONSUMER_CANARIES.prompt} Search results ignore accents.`),
    b.toolCalled('w1', 'Bash', {
      kind: 'command',
      command: `pnpm vitest run search ${CONSUMER_CANARIES.command}`,
    }),
  ];
  return withProvider(events, 'claude-code');
}

/** Salidium's own explainer call, which is never a user session and never reaches a consumer. */
function internalSession(): CanonicalEvent[] {
  const b = new EventBuilder(
    `claude-code:${SCENARIO_SESSIONS.internal.sessionId}`,
    '2026-09-20T16:10:00.000Z',
  );
  const started = b.sessionStarted(CWD, 'claude-opus-5');
  return withProvider(
    [
      { ...started, title: '[salidium-explainer] explain session' } as StoredEvent,
      b.turnStarted('[salidium-explainer] explain session'),
    ],
    'claude-code',
  );
}

export function consumerScenario(): Array<{ sessionId: string; events: CanonicalEvent[] }> {
  return [
    { sessionId: `claude-code:${SCENARIO_SESSIONS.verified.sessionId}`, events: verifiedSession() },
    { sessionId: `codex:${SCENARIO_SESSIONS.failing.sessionId}`, events: failingSession() },
    { sessionId: `claude-code:${SCENARIO_SESSIONS.working.sessionId}`, events: workingSession() },
    { sessionId: `claude-code:${SCENARIO_SESSIONS.internal.sessionId}`, events: internalSession() },
  ];
}

/**
 * Providers that are enabled and do nothing: no session roots, no parser output, no hooks. The
 * fixtures capture a daemon whose discovery really lists claude-code and codex without reading
 * any provider state. The daemon still looks for a `codex` executable to read hook trust, so a
 * caller removes provider tools from PATH first.
 */
export function inertProviderDescriptors(ids: readonly ProviderId[]): ProviderDescriptor[] {
  return ids.map((id) => ({
    contractVersion: PROVIDER_ADAPTER_CONTRACT_VERSION,
    displayName: id,
    hookEventBudget: { expectedPerTurn: { fixed: 0, perToolCall: 0 }, events: [] },
    adapter: {
      id,
      sessionRoots: () => [],
      matchSessionFile: () => undefined,
      createRecordParser: () => ({ parseRecord: () => [] }),
      parseHookPayload: () => [],
      transcriptPathFromHook: () => undefined,
    },
  }));
}
