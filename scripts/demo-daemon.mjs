/*
 * A real Salidium daemon, seeded with realistic runs, for screenshots and recordings.
 *
 * Nothing here is a mock. The events go through the daemon's own ingest, which validates and
 * redacts them, and the state the UI renders is folded by the real reducer. Everything the report
 * shows - the changed files, the checks, the review items, the verdict - is derived by the product
 * from this event log, not written down here. If the derivation changes, this demo changes with
 * it, which is the only way a screenshot stays honest.
 *
 *   node scripts/demo-daemon.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventBuilder } from '../packages/core/dist/testing/eventBuilders.js';
import { startDaemon } from '../packages/daemon/dist/index.js';

const SESSION = 'claude-code:demo-checkout';
const CWD = '/Users/dev/acme/checkout';
const MODEL = 'claude-opus-5';

/*
 * The instant this fixture calls now.
 *
 * Browsed, it is the real one, so a person reading the demo sees ages that are true. Photographed,
 * it is `CAPTURE_INSTANT` below, and then the whole fixture is a pure function of this file: the
 * same seed draws the same pixels today and next year.
 *
 * It used to be `Date.now()`, read afresh for each of the twenty-four sessions, which made the
 * pipeline irreproducible in two separate ways. Relative labels round to the minute and sixteen
 * captures take longer than a minute, so a session seeded twenty-six minutes back printed "26m
 * ago" early in a run and "27m ago" late in it. Absolute labels are worse: the History table and
 * the raw record print clock times, and two runs a minute apart printed "04:40 PM" and "04:41 PM"
 * down sixteen rows. Measured on 2026-08-20, five of the eight shots changed their bytes between
 * two runs of identical code, which is why nobody could tell a real capture change from noise.
 */
export const CAPTURE_INSTANT = Date.parse('2026-08-20T16:20:00.000Z');

let anchor = Date.now();

/** Minutes ago, as a canonical timestamp. Anchored once per boot, not per call. */
const ago = (minutes) => new Date(anchor - minutes * 60_000).toISOString();

/*
 * A full-scope run, deliberately. An earlier fixture ran `vitest run <one file>`, which the
 * classifier scores `scope: partial`, and `lastPass` ignores partial runs - so the verdict printed
 * "No passing test, build or typecheck run was observed in this session" while the Verified panel
 * of the same report showed a green test run. A screenshot of a product that claims its output is
 * true cannot contain a sentence its own evidence contradicts.
 *
 * With a full pass in turn one and no check at all in turn two, the verdict instead reads
 * "N files changed after the last passing check", which is arithmetic the agent did not do.
 */
const VITEST_FULL_PASS = `
 ✓ src/payments/ChargeService.test.ts (14 tests) 210ms
 ✓ src/checkout/RetryWorker.test.ts (9 tests) 154ms
 Test Files  46 passed (46)
      Tests  118 passed (118)
   Duration  6.41s
`;

/*
 * The suite passes and the command still fails, which is the one outcome the fixture never
 * produced: `deriveVerification` reads the summary line as a pass, sees an explicit non-zero exit
 * disagreeing with it, and records `partial` with an `exit-summary-mismatch` caveat. Every other
 * check in this file is a clean pass or a clean fail, so the Verified panel's `◐` mark, its
 * "partial" word and its caveat text had never been drawn by anything a reader could see.
 */
const VITEST_COVERAGE_SHORTFALL = `
 Test Files  46 passed (46)
      Tests  118 passed (118)
   Duration  7.12s

 % Coverage report from v8
 src/payments/refunds.ts   |   61.4 |     44.1 |
ERROR: Coverage for lines (78.9%) does not meet global threshold (85%)
`;

const VITEST_FAIL = `
 ❯ src/images/resolveUrl.test.ts (7 tests | 3 failed) 212ms
 Test Files  1 failed | 45 passed (46)
      Tests  3 failed | 115 passed (118)
   Duration  6.02s
`;

function titled(event, title) {
  return event.kind === 'session.started' ? { ...event, title } : event;
}

/*
 * The generated explanation is an event like any other, so the Why and How diagrams are drawn by
 * the product from data rather than posed. Two lanes make Why converge, which is the shape the
 * product reserves for a genuine race; an approach change draws the Was/Now pivot.
 *
 * The scenario is a double charge rather than a token-refresh bug on purpose. A visitor who has
 * never heard of Salidium needs no glossary to understand "some customers were charged twice", and
 * the harm is in the first sentence rather than four boxes into the diagram.
 */
function explanation(sessionId, ts, basedOnSeq) {
  return {
    id: `${sessionId}#explanation:${basedOnSeq}`,
    sessionId,
    ts,
    tsSource: 'provider',
    source: { provider: 'claude-code', channel: 'salidium' },
    kind: 'salidium.explanation',
    basedOnSeq,
    model: MODEL,
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
      chain: [
        'Two charges for one order',
        'Stripe accepts both',
        'The card is billed twice',
        'Support refunds it by hand',
      ],
    },
    how: {
      summary: 'One idempotency key per order, sent with every charge.',
      root: 'ChargeService.ts',
      steps: [
        'Derive a key per order',
        'Send it with the charge',
        'Stripe returns the first charge',
        'The worker reuses the key',
      ],
    },
    approachChange: {
      from: 'Lock the order row',
      fromSteps: ['Lock the row, then charge', 'Worker charges it again later'],
      why: 'The lock is gone by the time the worker runs, so a second charge still gets through.',
      to: 'One idempotency key per order',
      toSteps: ['Both paths send one key', 'The order is charged once'],
    },
  };
}

const temporary = await mkdtemp(join(tmpdir(), 'salidium-demo-'));

/**
 * Starts the daemon, seeds it, and hands back the URL plus a stop function. Exported so the
 * screenshot capture and the browsable demo are the same environment rather than two that have to
 * be kept in step.
 *
 * `at` is what the fixture and the daemon both call now. A capture passes `CAPTURE_INSTANT`; a
 * person browsing passes nothing and gets the wall clock.
 */
export async function startDemo({ at = Date.now() } = {}) {
  /*
   * No model call, and nothing appended after the seeding.
   *
   * The shipped default is `explainerCadence: 'turn'`, and a fresh home takes it, so booting this
   * fixture spawned a real `claude -p` for every session whose turn had ended and ingested a
   * `salidium.explanation` stamped at the wall clock. Measured on 2026-08-20: thirteen of the
   * twenty-four sessions had their last event rewritten to "now" over the first sixty seconds, so
   * the Recent group re-sorted and re-labelled itself underneath whatever was being photographed,
   * and the featured report changed while the capture was still running. It also made the site's
   * pictures depend on what a model happened to write that minute, which is the opposite of the
   * claim they carry. Everything the interface shows here is derived by the product from the
   * event log below, and the one explanation in it is written here on purpose.
   */
  process.env.SALIDIUM_EXPLAINER = 'off';

  anchor = at;

  const handle = await startDaemon({
    /*
     * And the daemon is told the same instant, because it decides one thing from the clock that
     * this fixture depends on: `effectiveStatus` calls a session idle once it has been silent for
     * fifteen minutes, however open its last turn is. Left on the wall clock, a fixture pinned to
     * a fixed instant would have its three Working sessions quietly demoted into Recent and the
     * session list would be photographed a group short.
     */
    now: () => at,
    home: join(temporary, 'salidium'),
    userHome: join(temporary, 'providers'),
    port: 0,
    historyDays: 0,
    gitEnrichment: false,
    providers: [],
    logLevel: 'silent',
    uiDist: fileURLToPath(new URL('../packages/ui/dist', import.meta.url)),
  });

  // Anchored to now, so every relative time in the interface reads honestly in a screenshot.
  const b = new EventBuilder(SESSION, ago(26));

  const events = [
    titled(b.sessionStarted(CWD, MODEL), 'Fix double charges on checkout retry'),

    b.turnStarted(
      'Some customers are charged twice when checkout retries, and support has to refund by hand. Fix it.',
    ),
    b.message(
      'Found it: the checkout request and the retry worker both create a charge for the same order.',
    ),
    // Grounds the Was/Now pivot in something the agent actually said.
    b.message(
      'Tried a row lock first; it still let a second charge through, so I moved to one idempotency key per order.',
    ),
    ...b.edit('call-1', `${CWD}/src/payments/ChargeService.ts`, 42, 12),
    ...b.edit('call-2', `${CWD}/src/checkout/RetryWorker.ts`, 3, 19),
    ...b.command('call-3', 'pnpm vitest run', VITEST_FULL_PASS, { exitCode: 0 }),
    ...b.command(
      'call-4',
      'git commit -am "one idempotency key per order"',
      '[main 4f2c1ab] one idempotency key per order\n 2 files changed, 45 insertions(+), 31 deletions(-)',
      { exitCode: 0 },
    ),
    b.turnEnded('Charging now goes through one idempotency key per order.'),

    /*
     * The second turn runs no check at all. The `claim-without-evidence` rule is scope-blind: any
     * pass inside the claiming turn suppresses it, including a one-file subset, so the turn that
     * makes the claim has to be empty of checks for the contradiction to be recorded.
     */
    b.turnStarted('Also update the docs and the Stripe mock.'),
    ...b.edit('call-5', `${CWD}/docs/payments.md`, 18, 2),
    ...b.edit('call-6', `${CWD}/src/payments/__mocks__/stripe.ts`, 6, 6),
    b.turnEnded('Docs and mock updated. All tests pass.'),
  ];

  /*
   * Stamped at the wall clock, and load-bearing: `needsYou` keeps an idle session in the group only
   * while its last event is under 30 minutes old, so this timestamp is what holds the hero there.
   * Moving it back to the run's own clock would silently drop the hero out of Needs you.
   */
  const lastSeq = events[events.length - 1].seq;
  events.push({ ...explanation(SESSION, ago(1), lastSeq), seq: lastSeq + 1 });

  handle.registry.ingest(SESSION, events, { cwd: CWD });
  handle.registry.flush(SESSION);

  /*
   * The rest of the list, and what puts a session in each group:
   *
   *   Needs you  `status === 'waiting'`, which `permission.requested` sets and any turn.ended
   *              clears, so the turn stays open and the permission is the last event. Or an open
   *              review item on a session that is still moving.
   *   Working    an open turn with activity inside the last 15 minutes and no review item. Past
   *              that, effectiveStatus downgrades it to idle and it falls through to Recent.
   *   Recent     everything finished and clean.
   */
  function other({ id, cwd, title, startedAgo, model = MODEL, build }) {
    const eb = new EventBuilder(id, ago(startedAgo));
    const list = [titled(eb.sessionStarted(cwd, model), title), ...build(eb)];
    handle.registry.ingest(id, list, { cwd });
    handle.registry.flush(id);
  }

  // --- Needs you: stopped on a person, or already broken -------------------

  other({
    id: 'claude-code:demo-coupon',
    cwd: '/Users/dev/acme/checkout',
    title: 'Add a coupon field to the checkout form',
    startedAgo: 7,
    build: (eb) => [
      eb.turnStarted('Add a coupon code field to checkout and apply it to the total.'),
      eb.message('The total is computed in one place, so the discount can go in beside it.'),
      ...eb.edit('cp-1', '/Users/dev/acme/checkout/src/checkout/Totals.ts', 14, 3),
      eb.permission('Bash', 'Run: gh pr create --fill'),
    ],
  });

  other({
    id: 'claude-code:demo-migrate',
    cwd: '/Users/dev/acme/api',
    title: 'Drop the legacy sessions table',
    startedAgo: 13,
    build: (eb) => [
      eb.turnStarted('The old sessions table is unused now. Remove it.'),
      eb.message('Checked for readers of the table and found none outside the migration.'),
      ...eb.edit('mg-1', '/Users/dev/acme/api/migrations/0043_drop_sessions.py', 22, 0),
      eb.permission('Bash', 'Run the migration against the staging database'),
    ],
  });

  /*
   * Still running, and already failing. This is the case the group exists for: the row renders as
   * Working with a flag on it, and gets hoisted because a check has gone red mid-turn.
   */
  other({
    id: 'claude-code:demo-cdn',
    cwd: '/Users/dev/acme/web',
    title: 'Move product images to the CDN',
    startedAgo: 3,
    build: (eb) => [
      eb.turnStarted('Serve product images from the CDN instead of the app server.'),
      ...eb.edit('cdn-1', '/Users/dev/acme/web/src/images/resolveUrl.ts', 26, 9),
      ...eb.edit('cdn-2', '/Users/dev/acme/web/src/images/Picture.tsx', 8, 4),
      ...eb.command('cdn-3', 'pnpm vitest run', VITEST_FAIL, { exitCode: 1 }),
    ],
  });

  // --- Working: an open turn, still moving, nothing flagged ----------------

  other({
    id: 'claude-code:demo-webhooks',
    cwd: '/Users/dev/acme/billing',
    title: 'Retry failed Stripe webhooks',
    startedAgo: 4,
    build: (eb) => [
      eb.turnStarted('Webhook retries give up after one attempt. Add backoff.'),
      eb.message('Reading the webhook handler to see where the retry budget is decided.'),
      ...eb.edit('wh-1', '/Users/dev/acme/billing/src/webhooks/retry.ts', 31, 4),
    ],
  });

  other({
    id: 'claude-code:demo-redis',
    cwd: '/Users/dev/acme/api',
    title: 'Cache the product list in Redis',
    startedAgo: 8,
    build: (eb) => [
      eb.turnStarted('The product list query runs on every page. Cache it.'),
      eb.message("Keying the cache per tenant so one shop cannot read another's list."),
      ...eb.edit('rd-1', '/Users/dev/acme/api/src/catalog/productList.ts', 22, 5),
    ],
  });

  /*
   * A subset run mid-turn: it opens no review item and resolves none, so the row stays in Working
   * while visibly having run a check. A second, quieter demonstration of the scope rule.
   */
  other({
    id: 'claude-code:demo-search',
    cwd: '/Users/dev/acme/web',
    title: 'Port the search box to the new field',
    startedAgo: 9,
    build: (eb) => [
      eb.turnStarted('Move the search box onto the new input component.'),
      ...eb.edit('sb-1', '/Users/dev/acme/web/src/search/SearchBox.tsx', 17, 11),
      ...eb.command(
        'sb-2',
        'pnpm vitest run src/search/SearchBox.test.ts',
        '\n      Tests  9 passed (9)\n',
        { exitCode: 0 },
      ),
    ],
  });

  /*
   * A long run, for the documentation's picture of the scrubber.
   *
   * The featured session is four files over two turns, which draws three marks on a track and so
   * illustrates none of what the page says about it: no failure to draw red, and nothing close
   * enough to another mark to be merged. This one is deliberately longer, and it is a separate
   * session so nothing about the featured one moves.
   */
  other({
    id: 'claude-code:demo-timeline',
    cwd: '/Users/dev/acme/api',
    title: 'Move invoice numbering off the sequence',
    startedAgo: 26,
    build: (eb) => [
      eb.turnStarted('Invoice numbers collide under load. Move them off the shared sequence.'),
      ...eb.edit('iv-1', '/Users/dev/acme/api/src/invoices/number.ts', 34, 12),
      ...eb.command('iv-2', 'pnpm vitest run', VITEST_FAIL, { exitCode: 1 }),
      eb.turnEnded('Three tests fail on the new allocator. Fixing.'),

      eb.turnStarted('Fix the allocator and run the suite again.'),
      ...eb.edit('iv-3', '/Users/dev/acme/api/src/invoices/allocator.ts', 21, 8),
      ...eb.command('iv-4', 'pnpm vitest run', '\n      Tests  118 passed (118)\n', {
        exitCode: 0,
      }),
      ...eb.command('iv-5', 'git commit -am "allocate invoice numbers per tenant"', '', {
        exitCode: 0,
      }),
      eb.turnEnded('Suite is green and the change is committed.'),

      /* Two checks inside one turn, close enough on the track that the marks merge. */
      eb.turnStarted('Check the types and the lint before opening it.'),
      ...eb.edit('iv-6', '/Users/dev/acme/api/src/invoices/index.ts', 6, 3),
      ...eb.command('iv-7', 'pnpm tsc --noEmit', '', { exitCode: 0 }),
      ...eb.command('iv-8', 'pnpm eslint .', '', { exitCode: 0 }),
      eb.turnEnded('Types and lint are clean.'),

      eb.turnStarted('Backfill the existing rows.'),
      ...eb.edit('iv-9', '/Users/dev/acme/api/migrations/0051_backfill_invoice_no.sql', 18, 0),
      ...eb.command('iv-10', 'pnpm vitest run', '\n      Tests  121 passed (121)\n', {
        exitCode: 0,
      }),
      ...eb.command('iv-11', 'git commit -am "backfill invoice numbers"', '', { exitCode: 0 }),
      eb.turnEnded('Backfilled, and the suite still passes.'),
    ],
  });

  /*
   * A check that passed and failed at once.
   *
   * Nothing else here reaches `outcome: 'partial'`, and the panel that draws it is the panel every
   * documentation page is a picture of. A coverage floor is the honest way to get there: the tests
   * genuinely passed, the command genuinely failed, and neither reading is wrong.
   */
  other({
    id: 'claude-code:demo-coverage',
    cwd: '/Users/dev/acme/billing',
    title: 'Bring the payments module up to the coverage floor',
    startedAgo: 17,
    build: (eb) => [
      eb.turnStarted('Coverage on the payments module is under the floor. Bring it up.'),
      eb.message('The refund path has no test at all, so that is where the missing lines are.'),
      ...eb.edit('cov-1', '/Users/dev/acme/billing/src/payments/refunds.test.ts', 46, 0),
      ...eb.command('cov-2', 'pnpm vitest run --coverage', VITEST_COVERAGE_SHORTFALL, {
        exitCode: 1,
      }),
      eb.turnEnded('The suite is green and coverage is still four points under the threshold.'),
    ],
  });

  /*
   * A session that handed its work to other agents.
   *
   * `Delegated`, `DelegatedRow` and the `Disclosure` primitive they sit in render only when a
   * session has subagents, and no fixture in this repository had one, so three components had
   * never been drawn against a running daemon and the section that quotes an agent verbatim had
   * never been photographed. Four lanes, deliberately unalike: one that wrote back at length and
   * so is clamped, one that wrote a single line and so is not, one that ended without reporting,
   * which is a different fact from never having been started, and one still running when the turn
   * ended.
   *
   * It also runs the suite narrowed to one file, so a `subset` tag and a `scope-partial` caveat
   * appear on a session the documentation actually shows.
   */
  other({
    id: 'claude-code:demo-fanout',
    cwd: '/Users/dev/acme/api',
    title: 'Find every unbounded query in the API',
    startedAgo: 19,
    build: (eb) => [
      eb.turnStarted(
        'Some list endpoints read the whole table. Find them and put a limit on each.',
      ),
      eb.message(
        'Three areas to read, so each one goes to its own agent and I collect the results.',
      ),
      eb.subagentStarted('sub-orders', 'explore', 'Read the orders endpoints'),
      eb.subagentStarted('sub-catalog', 'explore', 'Read the catalog endpoints'),
      eb.subagentStarted('sub-reports', 'explore', 'Read the reporting endpoints'),
      eb.subagentEnded(
        'sub-orders',
        'Four handlers under src/orders read the table without a limit. The worst is the customer history endpoint, which selects every order for a tenant and then slices in memory: on the largest tenant in the seed data that is 41,000 rows for a page of twenty. The other three are admin-only and bounded in practice by how much anyone scrolls, but none of them says so in code. All four take the same cursor helper that src/invoices already uses, so the change is the same four lines in each place.',
      ),
      eb.subagentEnded('sub-catalog', 'The catalog endpoints already paginate. Nothing to change.'),
      eb.subagentEnded('sub-reports'),
      eb.subagentStarted('sub-search', 'explore', 'Read the search endpoints'),
      ...eb.edit('fo-1', '/Users/dev/acme/api/src/orders/history.ts', 18, 6),
      ...eb.edit('fo-2', '/Users/dev/acme/api/src/orders/list.ts', 9, 3),
      ...eb.command(
        'fo-3',
        'pnpm vitest run src/orders/queries.test.ts',
        '\n      Tests  14 passed (14)\n',
        { exitCode: 0 },
      ),
      eb.turnEnded('The orders endpoints take a cursor now. Search is still being read.'),
    ],
  });

  // --- Recent: finished and clean ------------------------------------------

  const finished = [
    ['auth-rate', 'api', 'Rate limit the login endpoint', 22],
    ['csv-export', 'web', 'Stream the CSV export instead of buffering', 31],
    ['flaky-cart', 'web', 'Fix the flaky cart total test', 44],
    ['s3-presign', 'api', 'Presign S3 uploads on the server', 58],
    ['dark-mode', 'web', 'Finish dark mode on the settings page', 73],
    ['n-plus-one', 'api', 'Kill the N+1 in the orders list', 98],
    ['tz-bug', 'api', 'Store timestamps in UTC everywhere', 115],
    ['deps-bump', 'web', 'Bump dependencies and clear the audit', 128],
    ['sentry', 'api', 'Wire Sentry into the worker', 186],
    ['a11y-nav', 'web', 'Make the nav reachable by keyboard', 209],
    ['pdf-render', 'api', 'Render invoices as PDF in a job', 255],
    ['seed-script', 'api', 'Rewrite the seed script', 278],
    ['email-tpl', 'web', 'Move email templates out of the handler', 302],
    ['cache-keys', 'api', 'Namespace the cache keys per tenant', 365],
    ['logout-bug', 'web', 'Fix logout leaving a stale session', 412],
    ['webhook-log', 'api', 'Log webhook deliveries with their status', 458],
  ];

  for (const [slug, repo, title, startedAgo] of finished) {
    other({
      id: `claude-code:demo-${slug}`,
      cwd: `/Users/dev/acme/${repo}`,
      title,
      startedAgo,
      build: (eb) => [
        eb.turnStarted(title),
        ...eb.edit(`${slug}-1`, `/Users/dev/acme/${repo}/src/${slug}.ts`, 14, 6),
        ...eb.command(`${slug}-2`, 'pnpm vitest run', '\n      Tests  86 passed (86)\n', {
          exitCode: 0,
        }),
        eb.turnEnded('Done, and the suite is green.'),
      ],
    });
  }

  return {
    url: `http://127.0.0.1:${handle.port}/#token=${handle.token}`,
    session: SESSION,
    /* The instant every seeded timestamp is measured back from, and the daemon's own. */
    now: at,
    async stop() {
      await handle.stop();
      await rm(temporary, { recursive: true, force: true });
    },
  };
}

// Run directly to leave a browsable instance up: `node scripts/demo-daemon.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  const demo = await startDemo();
  console.log(`DEMO_URL ${demo.url}`);
  console.log(`DEMO_SESSION ${demo.session}`);
  const stop = async () => {
    await demo.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
