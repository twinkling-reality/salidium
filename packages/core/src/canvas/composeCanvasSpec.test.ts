import { describe, expect, it } from 'vitest';
import { applyEvent, createInitialState, projectSession } from '../index.ts';
import { EventBuilder } from '../testing/eventBuilders.ts';
import { collectValidCanvasRefs, composeCanvasSpec } from './composeCanvasSpec.ts';

function buildProjectedSession(opts?: { failingCheck?: boolean; subagent?: boolean }) {
  const sessionId = 'claude-code:canvas-spec-test';
  const state = createInitialState({
    sessionId,
    provider: 'claude-code',
    providerSessionId: 'canvas-spec-test',
  });
  const b = new EventBuilder(sessionId, '2026-11-01T16:00:00.000Z');
  const events = [
    b.sessionStarted('/repo/salidium', 'claude-sonnet-4-6'),
    b.turnStarted('Refactor SessionCanvas and verify dependency blast radius'),
    ...(opts?.subagent
      ? [
          b.subagentStarted('sub-1', 'research', 'Inspect @salidium/project-map links'),
          b.subagentEnded('sub-1', 'Found 2 Ring 1 importers'),
        ]
      : []),
    ...b.edit('edit-canvas', '/repo/salidium/packages/ui/src/components/SessionCanvas.tsx', 84, 12),
    ...b.edit('edit-view', '/repo/salidium/packages/ui/src/components/SessionView.tsx', 10, 2),
    ...(opts?.failingCheck
      ? b.command(
          'cmd-fail',
          'npx vitest run',
          'FAIL packages/ui/src/components/SessionCanvas.test.tsx\nTests  1 failed | 6 passed (7)',
          { exitCode: 1 },
        )
      : b.command('cmd-pass', 'npx vitest run', 'Tests  7 passed (7)', { exitCode: 0 })),
    b.turnEnded(),
  ];

  for (const ev of events) {
    applyEvent(state, ev);
  }
  return projectSession(state, Date.parse('2026-11-01T16:05:00.000Z'));
}

describe('composeCanvasSpec (salidium.canvas-spec/v1)', () => {
  it('promotes failure-chain to Block #1 when a verification check fails', () => {
    const view = buildProjectedSession({ failingCheck: true });
    const spec = composeCanvasSpec(view);

    expect(spec.format).toBe('salidium.canvas-spec/v1');
    expect(spec.composer).toBe('deterministic');
    expect(spec.headline).toContain('1 Failing Check');
    expect(spec.blocks[0]?.kind).toBe('failure-chain');
    expect(spec.blocks[0]?.priority).toBe('primary');
    expect(spec.blocks[0]?.refs).toContain('call:cmd-fail');
    expect(spec.blocks[0]?.refs).toContain(
      'file:/repo/salidium/packages/ui/src/components/SessionCanvas.tsx',
    );
  });

  it('includes blast-radius and subagent-fanout blocks bound by reference to ground truth', () => {
    const view = buildProjectedSession({ subagent: true });
    const spec = composeCanvasSpec(view, {
      links: {
        repositories: [{ root: '/repo/salidium', status: 'mapped' }],
        files: [
          {
            path: '/repo/salidium/packages/ui/src/components/SessionCanvas.tsx',
            relativePath: 'packages/ui/src/components/SessionCanvas.tsx',
            status: 'linked',
            neighbours: [
              {
                direction: 'imported-by',
                edge: 'e:0001',
                nodeKind: 'file',
                path: 'packages/ui/src/components/SessionCanvas.test.tsx',
                name: null,
                changed: false,
              },
            ],
          },
        ],
        modules: [
          {
            dependents: [
              {
                edge: 'e:0002',
                module: { name: 'salidium', manifest: 'packages/cli/package.json' },
              },
            ],
          },
        ],
      },
    });

    expect(spec.headline).toContain('1 Untouched Importer');
    expect(spec.headline).toContain('1 Subagent');

    const blastBlock = spec.blocks.find((b) => b.kind === 'blast-radius');
    expect(blastBlock).toBeDefined();
    expect(blastBlock?.priority).toBe('primary');
    expect(blastBlock?.reason).toContain('1 untouched importer');
    expect(blastBlock?.refs).toContain('file:packages/ui/src/components/SessionCanvas.test.tsx');
    expect(blastBlock?.refs).toContain('edge:e:0001');

    const fanoutBlock = spec.blocks.find((b) => b.kind === 'subagent-fanout');
    expect(fanoutBlock).toBeDefined();
    expect(fanoutBlock?.refs).toEqual(['subagent:sub-1']);
  });

  it('strips hallucinated model refs and enforces failure-chain when checks fail', () => {
    const view = buildProjectedSession({ failingCheck: true });
    const validRefs = collectValidCanvasRefs(view);
    expect(validRefs.has('file:/hallucinated/nonexistent.ts')).toBe(false);

    const spec = composeCanvasSpec(view, {
      explanation: {
        basedOnSeq: 10,
        model: 'claude-sonnet-4-6',
        at: '2026-11-01T16:04:00.000Z',
        what: { summary: 'Refactored SessionCanvas.', currently: null },
        why: { summary: 'Modularize lenses.', lanes: [], chain: ['Refactor canvas'] },
        how: { summary: 'Split components.', root: 'SessionCanvas', steps: ['Add SVG graph'] },
        approachChange: null,
        canvasBlocks: [
          {
            kind: 'topology',
            priority: 'primary',
            reason: 'Focus on SessionCanvas',
            refs: [
              'file:/hallucinated/nonexistent.ts',
              'file:/repo/salidium/packages/ui/src/components/SessionCanvas.tsx',
            ],
          },
        ],
      },
    });

    expect(spec.composer).toBe('model');
    expect(spec.model).toBe('claude-sonnet-4-6');
    // Safety invariant: failure-chain is still enforced at #1 even though model omitted it
    expect(spec.blocks[0]?.kind).toBe('failure-chain');
    const topologyBlock = spec.blocks.find((b) => b.kind === 'topology');
    expect(topologyBlock?.refs).toEqual([
      'file:/repo/salidium/packages/ui/src/components/SessionCanvas.tsx',
    ]);
    expect(topologyBlock?.refs).not.toContain('file:/hallucinated/nonexistent.ts');
  });
});
