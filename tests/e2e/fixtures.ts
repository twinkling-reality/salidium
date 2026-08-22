import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect } from '@playwright/test';
import { EventBuilder } from '../../packages/core/dist/testing/eventBuilders.js';
import { type DaemonHandle, startDaemon } from '../../packages/daemon/dist/index.js';
import type { CanonicalEvent } from '../../packages/protocol/dist/index.js';

const PRIMARY_SESSION = 'claude-code:e2e-primary';

export interface BrowserDaemon {
  url: string;
  token: string;
  primarySession: string;
  appendEdit(path: string): void;
}

type WorkerFixtures = { daemon: BrowserDaemon };

function titled(event: CanonicalEvent, title: string): CanonicalEvent {
  if (event.kind !== 'session.started') return event;
  return { ...event, title };
}

export const test = base.extend<Record<string, never>, WorkerFixtures>({
  daemon: [
    async ({ browserName: _browserName }, use) => {
      const temporary = await mkdtemp(join(tmpdir(), 'salidium-browser-e2e-'));
      let handle: DaemonHandle | undefined;
      try {
        const salidiumHome = join(temporary, 'salidium');
        await mkdir(salidiumHome, { recursive: true });
        // Browser fixtures exercise the explanation controls, not a real paid helper invocation.
        // Start at Off so a developer's locally installed CLI can never be called by a test run.
        await writeFile(
          join(salidiumHome, 'settings.json'),
          JSON.stringify({
            explainerCadence: 'off',
            explainerBackend: 'auto',
            explainerModel: null,
          }),
          { mode: 0o600 },
        );
        handle = await startDaemon({
          home: salidiumHome,
          userHome: join(temporary, 'providers'),
          port: 0,
          historyDays: 0,
          gitEnrichment: false,
          providers: [],
          logLevel: 'silent',
          uiDist: fileURLToPath(new URL('../../packages/ui/dist', import.meta.url)),
        });

        const primary = new EventBuilder(PRIMARY_SESSION, '2026-08-19T14:00:00.000Z');
        const first: CanonicalEvent[] = [
          titled(primary.sessionStarted('/repo/checkout'), 'Improve checkout safeguards'),
          primary.turnStarted('Improve checkout safeguards'),
          primary.message('I am tightening the checkout validation and will verify the result.'),
          ...primary.edit('edit-cart', '/repo/checkout/src/cart.ts', 8, 2),
          ...primary.command('test-cart', 'pnpm test', 'Tests  12 passed (12)', { exitCode: 0 }),
        ];
        handle.registry.ingest(PRIMARY_SESSION, first, { cwd: '/repo/checkout' });
        handle.registry.flush(PRIMARY_SESSION);

        /*
         * A session that handed work to other agents.
         *
         * `Delegated`, `DelegatedRow` and the `Disclosure` they sit in render only when a session
         * has subagents, and until now no fixture in this repository had one, so three components
         * shipped without ever being drawn. Two lanes, unalike on purpose: one that wrote back far
         * enough to be clamped, which is the only way the "more" control appears at all, and one
         * that ended without reporting, which is a different fact from never having started.
         */
        const fanout = new EventBuilder('claude-code:e2e-fanout', '2026-08-19T13:00:00.000Z');
        handle.registry.ingest(
          fanout.sessionId,
          [
            titled(fanout.sessionStarted('/repo/api'), 'Find the unbounded queries'),
            fanout.turnStarted('Find the unbounded queries'),
            fanout.subagentStarted('orders', 'explore', 'Read the orders endpoints'),
            fanout.subagentStarted('reports', 'explore', 'Read the reporting endpoints'),
            fanout.subagentEnded(
              'orders',
              'Four handlers under src/orders read the table without a limit, and the worst of them selects every order for a tenant before slicing a page of twenty out of it in memory. All four take the cursor helper that src/invoices already uses, so the change is the same four lines in each place, and the tests for it are the ones that already cover invoices. The reporting endpoints were left alone because they run behind a job rather than a request, and the admin list is bounded in practice by how far anyone scrolls, though nothing in the code says so.',
            ),
            fanout.subagentEnded('reports'),
            fanout.turnEnded('The orders endpoints take a cursor now.'),
          ],
          { cwd: '/repo/api' },
        );
        handle.registry.flush(fanout.sessionId);

        const empty = new EventBuilder('claude-code:empty-session', '2026-08-19T12:00:00.000Z');
        handle.registry.ingest(
          empty.sessionId,
          [titled(empty.sessionStarted('/repo/empty'), 'Empty transcript')],
          { cwd: '/repo/empty' },
        );
        handle.registry.flush(empty.sessionId);

        let nextEdit = 0;
        await use({
          url: `http://127.0.0.1:${handle.port}`,
          token: handle.token,
          primarySession: PRIMARY_SESSION,
          appendEdit(path: string) {
            nextEdit += 1;
            handle?.registry.ingest(
              PRIMARY_SESSION,
              primary.edit(`live-edit-${nextEdit}`, path, 3, 1),
            );
            handle?.registry.flush(PRIMARY_SESSION);
          },
        });
      } finally {
        await handle?.stop();
        await rm(temporary, { recursive: true, force: true });
      }
    },
    { scope: 'worker' },
  ],
});

export { expect };

export async function openSalidium(
  page: import('@playwright/test').Page,
  daemon: BrowserDaemon,
): Promise<void> {
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  // On a narrow viewport the session list intentionally makes the document inert/aria-hidden.
  // Its heading remains visibly painted behind the modal, but is correctly absent from role queries.
  await expect(page.locator('h1.masthead-title')).toHaveText('Improve checkout safeguards');
}
