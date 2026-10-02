import { join } from 'node:path';
import { EventBuilder } from '@salidium/core/testing';
import type { CanonicalEvent, StoredEvent } from '@salidium/protocol';
import {
  type ScratchRepository,
  scratchRepository,
} from '../../projectMap/__fixtures__/scratchRepository.ts';

/**
 * A small two-package workspace in a scratch repository, a linked worktree of it, and a synthetic
 * live session that changes files in both, in a third directory that is not a repository, and one
 * file that was never committed. Every name and path is invented.
 *
 * The session's events are stamped with the current time so the daemon's live enrichers run: the
 * git snapshot enricher reads HEAD at session start and turn end, and the file locator records
 * which working tree holds each changed file. Nothing here writes to the repository after setup.
 */
export interface LinksScenario {
  repo: ScratchRepository;
  /** The linked worktree's top level. */
  lane: string;
  /** A directory outside any repository that the session also writes in. */
  scratch: string;
  first: string;
  head: string;
  sessionId: string;
  events(now?: number): CanonicalEvent[];
  remove(): void;
}

export function linksScenario(sessionId = 'claude-code:links-e2e'): LinksScenario {
  const repo = scratchRepository();
  repo.write(
    'package.json',
    JSON.stringify({ name: 'acme', private: true, workspaces: ['packages/*'] }, null, 2),
  );
  repo.write(
    'packages/core/package.json',
    JSON.stringify({ name: '@acme/core', exports: './src/pay.ts' }, null, 2),
  );
  repo.write(
    'packages/core/src/money.ts',
    'export const cents = (n: number) => Math.round(n * 100);\n',
  );
  repo.write(
    'packages/core/src/pay.ts',
    "import { z } from 'zod';\nimport { cents } from './money.ts';\n\nexport const charge = (n: number) => z.number().parse(cents(n));\n",
  );
  repo.write('packages/core/src/pay.test.ts', "import { charge } from './pay.ts';\n\ncharge(1);\n");
  repo.write(
    'packages/app/package.json',
    JSON.stringify({ name: '@acme/app', dependencies: { '@acme/core': 'workspace:*' } }, null, 2),
  );
  repo.write(
    'packages/app/src/checkout.ts',
    "import { charge } from '@acme/core';\n\nexport const checkout = () => charge(5);\n",
  );
  repo.write('README.md', '# acme\n');
  const first = repo.commit('Start the workspace');
  repo.write(
    'packages/core/src/refund.ts',
    "import { cents } from './money.ts';\nexport const refund = cents;\n",
  );
  const head = repo.commit('Add refunds');

  const lane = join(repo.parent, 'repo-refunds');
  repo.git(['worktree', 'add', '-q', '-b', 'refunds', lane]);
  const scratch = join(repo.parent, 'scratch');

  return {
    repo,
    lane,
    scratch,
    first,
    head,
    sessionId,
    events(now = Date.now()) {
      // Ten events five seconds apart, ending about now: live to the enrichers.
      const b = new EventBuilder(sessionId, new Date(now - 60_000).toISOString());
      const started = b.sessionStarted(repo.dir, 'test-model');
      const events: StoredEvent[] = [
        { ...started, title: 'Round refunds to the cent' } as StoredEvent,
        b.turnStarted('Round refunds to the cent'),
        ...b.edit('e1', join(repo.dir, 'packages/core/src/pay.ts'), 4, 1),
        ...b.edit('e2', join(lane, 'packages/core/src/money.ts'), 2, 1),
        ...b.edit('e3', join(repo.dir, 'packages/core/src/fees.ts'), 12, 0),
        ...b.edit('e4', join(scratch, 'notes.md'), 3, 0),
        ...b.edit('e5', join(repo.dir, 'README.md'), 1, 0),
        b.turnEnded('Refunds now round to the cent.'),
      ];
      return events.map(({ seq: _seq, ...event }) => event) as CanonicalEvent[];
    },
    remove() {
      try {
        repo.git(['worktree', 'remove', '--force', lane]);
      } catch {
        // Removed with the parent below either way.
      }
      repo.remove();
    },
  };
}
