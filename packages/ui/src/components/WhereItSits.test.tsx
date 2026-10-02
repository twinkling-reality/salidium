import { type ExecutionLinks, ExecutionLinksSchema, type FileLink } from '@salidium/project-map';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { shellWord, WhereItSits } from './WhereItSits.tsx';

const REPO = '/work/acme';
const OTHER = '/work/other repo';
const END = '2'.repeat(40);

const core = {
  id: 'module:package.json:packages/core',
  name: '@acme/core',
  manifest: 'packages/core/package.json',
  ecosystem: 'npm' as const,
};
const app = {
  id: 'module:package.json:packages/app',
  name: '@acme/app',
  manifest: 'packages/app/package.json',
  ecosystem: 'npm' as const,
};
const edge = (n: number) => `e:${String(n).padStart(16, '0')}`;

function unplaced(path: string, status: FileLink['status'], repository: string | null = null) {
  return {
    path,
    status,
    repository,
    worktree: repository,
    relativePath: repository ? path.slice(repository.length + 1) : null,
    node: null,
    role: null,
    modules: [],
    neighbours: [],
    neighboursTotal: 0,
    neighboursTruncated: false,
  };
}

function sample(): ExecutionLinks {
  return ExecutionLinksSchema.parse({
    format: 'salidium.execution-links',
    version: 0,
    experimental: true,
    generatedAt: '2026-10-02T12:00:00.000Z',
    sessionId: 'claude-code:s1',
    anchors: {
      repository: REPO,
      atStart: null,
      atLatestTurnEnd: {
        head: END,
        branch: 'main',
        at: '2026-10-02T11:00:00.000Z',
        provenance: 'observed',
      },
    },
    repositories: [
      {
        root: REPO,
        worktrees: [REPO],
        status: 'mapped',
        commit: { id: END, chosen: 'latest-turn-end', provenance: 'observed' },
        unavailable: null,
        commitTime: '2026-10-01T00:00:00.000Z',
        mapComplete: true,
      },
      {
        root: OTHER,
        worktrees: [OTHER],
        status: 'not-opted-in',
        commit: null,
        unavailable: null,
        commitTime: null,
        mapComplete: null,
      },
    ],
    files: [
      {
        path: `${REPO}/packages/core/src/pay.ts`,
        status: 'linked',
        repository: REPO,
        worktree: '/work/acme-lane',
        relativePath: 'packages/core/src/pay.ts',
        node: 'file:packages/core/src/pay.ts',
        role: null,
        modules: [
          { module: core, kind: 'contains', provenance: 'observed', rule: 'nearest package.json' },
        ],
        neighbours: [
          ['imports', 'packages/core/src/money.ts', 'probe', false],
          ['imported-by', 'packages/app/src/checkout.ts', 'exports:development', false],
          ['imported-by', 'packages/core/src/pay.test.ts', 'ts-extension', true],
        ]
          .map(([direction, path, rule, changed], i) => ({
            direction,
            edge: edge(i),
            kind: 'imports',
            provenance: 'observed',
            rule,
            node: `file:${path}`,
            nodeKind: 'file',
            path,
            name: null,
            role: String(path).includes('.test.')
              ? { value: 'test', provenance: 'inferred', rule: 'name matches *.test.* or *.spec.*' }
              : null,
            changed,
            evidence: [{ path: 'packages/core/src/pay.ts', line: 3 }],
          }))
          .concat([
            {
              direction: 'imports',
              edge: edge(9),
              kind: 'imports',
              provenance: 'observed',
              rule: 'external',
              node: 'package:zod',
              nodeKind: 'external-package',
              path: null,
              name: 'zod',
              role: null,
              changed: false,
              evidence: [],
            },
          ]),
        neighboursTotal: 4,
        neighboursTruncated: false,
      },
      unplaced(`${REPO}/packages/core/src/fresh.ts`, 'not-in-map', REPO),
      unplaced(`${OTHER}/index.ts`, 'repository-not-mapped', OTHER),
      unplaced('/tmp/scratch/notes.md', 'outside-repository'),
      unplaced('/work/old/thing.ts', 'repository-unknown'),
    ],
    filesTotal: 5,
    filesOmitted: 0,
    modules: [
      {
        repository: REPO,
        module: core,
        changedFiles: ['packages/core/src/pay.ts'],
        dependents: [
          {
            module: app,
            edge: edge(20),
            provenance: 'observed',
            rule: 'package.json dependency on a package in this tree',
          },
        ],
        dependentsTotal: 1,
        dependentsTruncated: false,
      },
    ],
    modulesTruncated: false,
  });
}

const render = (links: ExecutionLinks, widened = false) =>
  renderToStaticMarkup(
    <WhereItSits links={links} widened={widened} onWiden={() => {}} onRetry={() => {}} />,
  );

/** Text only, so assertions read the words a person reads. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');

describe('WhereItSits', () => {
  it('places each changed file in its module at an observed commit', () => {
    const out = text(render(sample()));
    expect(out).toContain(`/work/acme at ${END.slice(0, 7)} as of the latest turn end observed`);
    expect(out).toContain('@acme/core packages/core/package.json');
    expect(out).toContain('packages/core/src/pay.ts');
    expect(out).toContain('in worktree /work/acme-lane');
  });

  it('shows ring 1 whole, with the rule and the inferred test role', () => {
    const out = text(render(sample()));
    expect(out).toContain('Imports 1 packages/core/src/money.ts probe, line 3');
    expect(out).toContain('Imported by 2');
    expect(out).toContain('packages/app/src/checkout.ts exports:development, line 3');
    expect(out).toContain('packages/core/src/pay.test.ts also changed test, inferred ts-extension');
    expect(out).toContain('Packages zod');
  });

  it('keeps ring 2 behind a pressed control', () => {
    const closed = render(sample());
    expect(closed).toContain('aria-pressed="false"');
    expect(text(closed)).toContain('Show what depends on these modules');
    expect(text(closed)).not.toContain('Depended on by');
    const open = render(sample(), true);
    expect(open).toContain('aria-pressed="true"');
    expect(text(open)).toContain(
      'Depended on by @acme/app packages/app/package.json package.json dependency on a package in this tree',
    );
  });

  it('explains every status in plain words', () => {
    const out = text(render(sample()));
    expect(out).toContain('Not in the map at that commit: added after it, or never committed.');
    expect(out).toContain('In no Git repository when Salidium saw the change.');
    expect(out).toContain('Salidium did not record which repository held these');
    expect(out).toContain('Salidium has not been allowed to read this repository, so it has not.');
  });

  it('says how to opt a repository in, quoted to paste', () => {
    const out = text(render(sample()));
    expect(out).toContain("salidium map allow '/work/other repo'");
    expect(out).toContain("salidium map revoke '/work/other repo'");
    expect(out).toContain('never your working tree');
    expect(shellWord('/work/acme')).toBe('/work/acme');
    expect(shellWord("/work/it's")).toBe(`'/work/it'\\''s'`);
  });

  it('says why a repository has no map, and never claims a revision it did not see', () => {
    const links = sample();
    const repository = links.repositories[0];
    if (!repository) throw new Error('fixture');
    const words: Array<[Partial<typeof repository>, string]> = [
      [{ status: 'no-revision', commit: null }, 'never saw which commit this repository was at'],
      [{ status: 'revision-gone', commit: null }, 'no longer exist in this repository'],
      [
        { status: 'map-unavailable', unavailable: 'over-bound' },
        'larger than the experimental map reads',
      ],
      [{ status: 'map-unavailable', unavailable: 'busy' }, 'Try again'],
      [
        { status: 'map-unavailable', unavailable: 'repository-unsupported', commit: null },
        'cannot read this repository safely',
      ],
    ];
    for (const [change, expected] of words) {
      const out = text(
        render({
          ...links,
          repositories: [{ ...repository, ...change, commitTime: null, mapComplete: null }],
          files: [unplaced(`${REPO}/a.ts`, 'repository-not-mapped', REPO)],
          modules: [],
        }),
      );
      expect(out).toContain(expected);
      expect(out).not.toContain('as of the latest turn end');
    }
  });

  it('has a clear empty state for a session that changed nothing', () => {
    const out = text(render({ ...sample(), files: [], filesTotal: 0, modules: [] }));
    expect(out).toContain('This session changed no files, so there is nothing to place.');
  });

  it('draws no component, responsibility or data flow', () => {
    const out = text(render(sample(), true)).toLowerCase();
    for (const word of ['component', 'responsib', 'data flow', 'calls '])
      expect(out).not.toContain(word);
  });
});
