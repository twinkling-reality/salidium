import type { Explanation, SessionView } from '@salidium/core';
import type { ExecutionLinks } from '@salidium/project-map';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildConnectorPath,
  canvasStyleToInlineVars,
  contrastRatio,
  DEFAULT_CANVAS_STYLE_CONFIG,
  oklabLightness,
  parseHexRgb,
} from '../lib/visualPresets.ts';
import { useAppStore } from '../store/appStore.ts';
import { SessionCanvas } from './SessionCanvas.tsx';

function makeSessionView(): SessionView {
  return {
    strip: {
      status: 'completed',
      turns: 2,
      filesChanged: 2,
      linesAdded: 48,
      linesRemoved: 12,
      commits: 1,
      reviewOpen: 1,
      remaining: 1,
    },
    verdict: {
      headline: 'Tests passed, 1 file edited after last check',
      tone: 'attention',
      epistemic: 'observed',
      because: '42/42 tests passed, then packages/ui/src/App.tsx changed',
      refs: ['ev-test-1'],
    },
    report: {
      ask: {
        text: 'Add modular diagram lenses and studio canvas styling',
        epistemic: 'observed',
        refs: ['ev-prompt-1'],
        author: 'user',
      },
      whatNow: {
        text: 'Added System, Execution, and Verification lenses alongside Narrative.',
        epistemic: 'reported',
        refs: ['ev-msg-2'],
        author: 'agent',
      },
      plan: [{ text: 'Add unit tests for SessionCanvas', status: 'in_progress' }],
      files: [
        { path: '/repo/packages/daemon/src/daemon.ts', mark: '~' },
        { path: '/repo/packages/ui/src/App.tsx', mark: '~' },
      ],
      runtimeMs: 14_000,
    },
    review: {
      glance: '1 open review item',
      items: [
        {
          id: 'rev-1',
          rule: 'unverified_edits',
          severity: 'medium',
          label: 'Edited after last verification',
          summary: 'packages/ui/src/App.tsx was modified after the last test run.',
          refs: ['call-edit-2'],
          createdAt: '2026-04-01T12:04:00.000Z',
          epistemic: 'observed',
        },
      ],
      groups: [
        {
          rule: 'unverified_edits',
          label: 'Edited after last verification',
          severity: 'medium',
          occurrences: 1,
          createdAt: '2026-04-01T12:04:00.000Z',
          items: [
            {
              id: 'rev-1',
              rule: 'unverified_edits',
              severity: 'medium',
              label: 'Edited after last verification',
              summary: 'packages/ui/src/App.tsx was modified after the last test run.',
              refs: ['call-edit-2'],
              createdAt: '2026-04-01T12:04:00.000Z',
              epistemic: 'observed',
              repeats: 1,
            },
          ],
        },
      ],
      resolvedCount: 0,
    },
    changes: {
      glance: '2 files (+48/-12)',
      files: [
        {
          path: '/repo/packages/daemon/src/daemon.ts',
          changeCount: 2,
          linesAdded: 30,
          linesRemoved: 8,
          kinds: ['edit'],
          lastChangedAt: '2026-04-01T12:01:00.000Z',
          lastCallId: 'call-edit-1',
          verifiedAfter: true,
          verifiedBy: '42/42 tests passed (vitest)',
          turnIndexes: [1],
        },
        {
          path: '/repo/packages/ui/src/App.tsx',
          changeCount: 1,
          linesAdded: 18,
          linesRemoved: 4,
          kinds: ['edit'],
          lastChangedAt: '2026-04-01T12:04:00.000Z',
          lastCallId: 'call-edit-2',
          verifiedAfter: false,
          turnIndexes: [2],
        },
      ],
      commands: [
        {
          callId: 'call-cmd-1',
          command: 'pnpm test',
          at: '2026-04-01T12:02:00.000Z',
          status: 'completed',
          exit: { code: 0, ok: true },
          durationMs: 2100,
          isVerification: true,
          turnIndex: 1,
        },
      ],
      commits: [
        {
          sha: 'a1b2c3d4e5f6',
          at: '2026-04-01T12:05:00.000Z',
          callId: 'call-commit-1',
        },
      ],
    },
    verified: {
      glance: '1 pass',
      runs: [
        {
          id: 'ver-1',
          callId: 'call-cmd-1',
          at: '2026-04-01T12:02:00.000Z',
          label: '42/42 tests passed (vitest)',
          method: 'test',
          runner: 'vitest',
          outcome: 'pass',
          counts: { passed: 42, failed: 0, total: 42 },
          scope: 'full',
          exit: { code: 0, ok: true },
          epistemic: 'observed',
          caveats: [],
          stale: true,
          command: 'pnpm test',
          turnIndex: 1,
        },
      ],
      summary: [
        {
          id: 'ver-1',
          callId: 'call-cmd-1',
          at: '2026-04-01T12:02:00.000Z',
          label: '42/42 tests passed (vitest)',
          method: 'test',
          runner: 'vitest',
          outcome: 'pass',
          counts: { passed: 42, failed: 0, total: 42 },
          scope: 'full',
          exit: { code: 0, ok: true },
          epistemic: 'observed',
          caveats: [],
          stale: true,
          command: 'pnpm test',
          turnIndex: 1,
          laterUnreadable: 0,
        },
      ],
      unverifiedFiles: ['/repo/packages/ui/src/App.tsx'],
      claims: [],
    },
    left: {
      glance: '1 item left',
      items: [
        {
          id: 'left-1',
          text: 'Run final verification after UI edit',
          status: 'in_progress',
          epistemic: 'observed',
          source: 'plan',
          refs: [],
        },
      ],
    },
    turns: [
      {
        id: 'turn-1',
        index: 1,
        prompt: 'Inspect daemon storage lifecycle and run tests',
        headline: 'Inspect daemon storage lifecycle and run tests',
        startedAt: '2026-04-01T12:00:00.000Z',
        endedAt: '2026-04-01T12:02:30.000Z',
        outcome: 'completed',
        activityCount: 3,
        files: ['/repo/packages/daemon/src/daemon.ts'],
        linesAdded: 30,
        linesRemoved: 8,
        verifications: [
          {
            id: 'ver-1',
            callId: 'call-cmd-1',
            at: '2026-04-01T12:02:00.000Z',
            label: '42/42 tests passed (vitest)',
            method: 'test',
            runner: 'vitest',
            outcome: 'pass',
            counts: { passed: 42, failed: 0, total: 42 },
            scope: 'full',
            exit: { code: 0, ok: true },
            epistemic: 'observed',
            caveats: [],
            stale: true,
            command: 'pnpm test',
            turnIndex: 1,
          },
        ],
        activities: [
          {
            callId: 'call-read-1',
            kind: 'fileRead',
            title: 'Read packages/daemon/src/daemon.ts',
            toolName: 'Read',
            startedAt: '2026-04-01T12:00:10.000Z',
            status: 'completed',
            isVerification: false,
            eventIds: ['ev-read-1'],
          },
          {
            callId: 'call-edit-1',
            kind: 'fileEdit',
            title: 'Edit packages/daemon/src/daemon.ts',
            toolName: 'Edit',
            startedAt: '2026-04-01T12:01:00.000Z',
            status: 'completed',
            isVerification: false,
            eventIds: ['ev-edit-1'],
          },
          {
            callId: 'call-cmd-1',
            kind: 'command',
            title: 'pnpm test',
            toolName: 'Bash',
            startedAt: '2026-04-01T12:02:00.000Z',
            status: 'completed',
            isVerification: true,
            exit: { code: 0, ok: true },
            eventIds: ['ev-cmd-1'],
          },
        ],
        claims: [],
      },
      {
        id: 'turn-2',
        index: 2,
        prompt: 'Update App.tsx and commit',
        headline: 'Update App.tsx and commit',
        startedAt: '2026-04-01T12:03:00.000Z',
        endedAt: '2026-04-01T12:05:10.000Z',
        outcome: 'completed',
        activityCount: 1,
        files: ['/repo/packages/ui/src/App.tsx'],
        linesAdded: 18,
        linesRemoved: 4,
        verifications: [],
        activities: [
          {
            callId: 'call-edit-2',
            kind: 'fileEdit',
            title: 'Edit packages/ui/src/App.tsx',
            toolName: 'Edit',
            startedAt: '2026-04-01T12:04:00.000Z',
            status: 'completed',
            isVerification: false,
            eventIds: ['ev-edit-2'],
          },
        ],
        claims: [],
      },
    ],
    subagents: [
      {
        id: 'sub-1',
        agentType: 'research',
        description: 'Audit storage endpoints',
        startedAt: '2026-04-01T12:00:20.000Z',
        endedAt: '2026-04-01T12:01:30.000Z',
        toolCalls: 4,
        eventId: 'ev-sub-1',
      },
    ],
    ingest: { warnings: 0, redactions: 0, compactions: 0 },
  };
}

function makeExplanation(): Explanation {
  return {
    basedOnSeq: 12,
    model: 'claude-sonnet-4-6',
    at: '2026-04-01T12:05:30.000Z',
    what: {
      summary:
        'Added multi-lens session canvas with deterministic system, execution, and verification diagrams.',
      currently: null,
    },
    why: {
      summary:
        'Users needed technical architecture and execution views even when model explanations are off.',
      lanes: [],
      chain: [
        'Single hardcoded diagram',
        'Blank canvas when Local only',
        'Modular multi-lens canvas',
      ],
    },
    how: {
      summary: 'Grouped observed session records into switchable lenses and visual styles.',
      root: 'SessionCanvas',
      steps: ['SystemArchitectureLens', 'ExecutionSequenceLens', 'VerificationMatrixLens'],
    },
    approachChange: null,
  };
}

describe('SessionCanvas', () => {
  beforeEach(() => {
    useAppStore.setState({
      canvasLens: 'auto',
      canvasStyle: 'blueprint',
      canvasStyleConfig: DEFAULT_CANVAS_STYLE_CONFIG,
    });
  });

  it('defaults Auto lens to deterministic System architecture view when no model explanation exists', () => {
    const view = makeSessionView();
    const html = renderToStaticMarkup(
      <SessionCanvas
        view={view}
        sessionId="sess-1"
        provider="claude-code"
        entrypoint="antigravity"
        cwd="/repo"
        displayedExplanation={undefined}
        showingPersonalized={false}
        hasAlternate={false}
        personalizerOpen={false}
        onClosePersonalizer={() => {}}
        hasCurrentPresentation={false}
        explanationStatus="disabled"
        explanationCadence="off"
        onRef={() => {}}
      />,
    );

    expect(html).toContain('data-canvas-lens="system"');
    expect(html).toContain('data-canvas-style="blueprint"');
    expect(html).toContain('Session Overview');
    expect(html).toContain('Agent &amp; Tools');
    expect(html).toContain('Antigravity');
    expect(html).toContain('Tools Used');
    expect(html).toContain('Terminal');
    expect(html).toContain('Edit');
    expect(html).toContain('Read');
    expect(html).toContain('Subagent');
    expect(html).toContain('Edited Files (2)');
    expect(html).toContain('Checks &amp; Review');
    expect(html).toContain('Observed Session Telemetry · Deterministic');
  });

  it('defaults Auto lens to Narrative view when a generated model explanation exists', () => {
    const view = makeSessionView();
    const explanation = makeExplanation();
    const html = renderToStaticMarkup(
      <SessionCanvas
        view={view}
        sessionId="sess-1"
        provider="claude-code"
        cwd="/repo"
        displayedExplanation={explanation}
        showingPersonalized={false}
        hasAlternate={false}
        personalizerOpen={false}
        onClosePersonalizer={() => {}}
        hasCurrentPresentation={false}
        explanationStatus="generated"
        explanationCadence="turn"
        onRef={() => {}}
      />,
    );

    expect(html).toContain('data-canvas-lens="narrative"');
    expect(html).toContain(
      'Added multi-lens session canvas with deterministic system, execution, and verification diagrams.',
    );
    expect(html).toContain('Generated by claude-sonnet-4-6');
  });

  it('renders ObservedBlueprintFallback alongside ExplanationPending when Narrative lens is selected without a model explanation', () => {
    const view = makeSessionView();
    const html = renderToStaticMarkup(
      <SessionCanvas
        view={view}
        sessionId="sess-1"
        provider="claude-code"
        cwd="/repo"
        displayedExplanation={undefined}
        showingPersonalized={false}
        hasAlternate={false}
        personalizerOpen={false}
        onClosePersonalizer={() => {}}
        hasCurrentPresentation={false}
        explanationStatus="disabled"
        explanationCadence="off"
        lens="narrative"
        style="studio"
        onRef={() => {}}
      />,
    );

    expect(html).toContain('data-canvas-lens="narrative"');
    expect(html).toContain('data-canvas-style="studio"');
    expect(html).toContain('No model-written Why or How.');
    expect(html).toContain('Observed Progression');
    expect(html).toContain('Touched Subsystems');
  });

  it('renders turn-by-turn Explore / Mutate / Verify swimlanes in Execution lens', () => {
    const view = makeSessionView();
    const html = renderToStaticMarkup(
      <SessionCanvas
        view={view}
        sessionId="sess-1"
        provider="claude-code"
        cwd="/repo"
        displayedExplanation={undefined}
        showingPersonalized={false}
        hasAlternate={false}
        personalizerOpen={false}
        onClosePersonalizer={() => {}}
        hasCurrentPresentation={false}
        explanationStatus="disabled"
        explanationCadence="off"
        lens="sequence"
        onRef={() => {}}
      />,
    );

    expect(html).toContain('data-canvas-lens="sequence"');
    expect(html).toContain('Step-by-Step Progress');
    expect(html).toContain('Inspect daemon storage lifecycle and run tests');
    expect(html).toContain('Update App.tsx and commit');
    expect(html).toContain('1. Read &amp; Explored');
    expect(html).toContain('1 read/search');
    expect(html).toContain('2. Edited');
    expect(html).toContain('3. Checked');
  });

  it('renders coverage meter, verified files, and unverified/open attention items in Verification lens', () => {
    const view = makeSessionView();
    const html = renderToStaticMarkup(
      <SessionCanvas
        view={view}
        sessionId="sess-1"
        provider="claude-code"
        cwd="/repo"
        displayedExplanation={undefined}
        showingPersonalized={false}
        hasAlternate={false}
        personalizerOpen={false}
        onClosePersonalizer={() => {}}
        hasCurrentPresentation={false}
        explanationStatus="disabled"
        explanationCadence="off"
        lens="verification"
        onRef={() => {}}
      />,
    );

    expect(html).toContain('data-canvas-lens="verification"');
    expect(html).toContain('Verification Coverage &amp; Blast Radius');
    expect(html).toContain('1 of 2 modified files verified after last edit');
    expect(html).toContain('50% covered');
    expect(html).toContain('Verified Surface (1)');
    expect(html).toContain('Unverified / Needs Attention (3)');
    expect(html).toContain('Edited after last verification');
    expect(html).toContain('Run final verification after UI edit');
  });

  it('integrates @salidium/project-map dependency edges and Ring 1 / Ring 2 blast-radius neighbors into the System lens', () => {
    const view = makeSessionView();
    const links: ExecutionLinks = {
      format: 'salidium.execution-links',
      version: 0,
      experimental: true,
      sessionId: 'sess-1',
      generatedAt: '2026-04-01T12:05:30.000Z',
      anchors: {
        atStart: null,
        atLatestTurnEnd: null,
      },
      repositories: [
        {
          root: '/repo',
          worktrees: ['/repo'],
          status: 'mapped',
          unavailable: null,
          commit: {
            id: 'a1b2c3d4e5f60123456789abcdef0123456789ab',
            chosen: 'latest-turn-end',
            provenance: 'observed',
          },
          commitTime: '2026-04-01T12:05:00.000Z',
          mapComplete: true,
        },
      ],
      files: [
        {
          path: '/repo/packages/daemon/src/daemon.ts',
          relativePath: 'packages/daemon/src/daemon.ts',
          repository: '/repo',
          worktree: '/repo',
          status: 'linked',
          node: 'file:packages/daemon/src/daemon.ts',
          role: null,
          modules: [
            {
              module: {
                id: 'module:package.json:packages/daemon',
                name: '@salidium/daemon',
                manifest: 'packages/daemon/package.json',
                ecosystem: 'npm',
              },
              kind: 'contains',
              provenance: 'observed',
              rule: 'nearest-package-json',
            },
          ],
          neighbours: [
            {
              direction: 'imports',
              edge: 'e:0000000000000001',
              kind: 'imports',
              provenance: 'observed',
              rule: 'ts-relative',
              node: 'file:packages/daemon/src/store.ts',
              nodeKind: 'file',
              path: 'packages/daemon/src/store.ts',
              name: null,
              role: null,
              changed: false,
              evidence: [{ path: 'packages/daemon/src/daemon.ts', line: 14 }],
            },
            {
              direction: 'imported-by',
              edge: 'e:0000000000000002',
              kind: 'imports',
              provenance: 'observed',
              rule: 'ts-relative',
              node: 'file:packages/daemon/src/daemon.test.ts',
              nodeKind: 'file',
              path: 'packages/daemon/src/daemon.test.ts',
              name: null,
              role: { value: 'test', provenance: 'inferred', rule: 'suffix:.test.ts' },
              changed: false,
              evidence: [{ path: 'packages/daemon/src/daemon.test.ts', line: 3 }],
            },
            {
              direction: 'imports',
              edge: 'e:0000000000000003',
              kind: 'imports',
              provenance: 'observed',
              rule: 'package-specifier',
              node: 'package:@salidium/core',
              nodeKind: 'external-package',
              path: null,
              name: '@salidium/core',
              role: null,
              changed: false,
              evidence: [{ path: 'packages/daemon/src/daemon.ts', line: 1 }],
            },
          ],
          neighboursTotal: 3,
          neighboursTruncated: false,
        },
        {
          path: '/repo/packages/ui/src/App.tsx',
          relativePath: 'packages/ui/src/App.tsx',
          repository: '/repo',
          worktree: '/repo',
          status: 'linked',
          node: 'file:packages/ui/src/App.tsx',
          role: null,
          modules: [
            {
              module: {
                id: 'module:package.json:packages/ui',
                name: '@salidium/ui',
                manifest: 'packages/ui/package.json',
                ecosystem: 'npm',
              },
              kind: 'contains',
              provenance: 'observed',
              rule: 'nearest-package-json',
            },
          ],
          neighbours: [
            {
              direction: 'imports',
              edge: 'e:0000000000000004',
              kind: 'imports-type',
              provenance: 'observed',
              rule: 'workspace-export',
              node: 'file:packages/daemon/src/daemon.ts',
              nodeKind: 'file',
              path: 'packages/daemon/src/daemon.ts',
              name: null,
              role: null,
              changed: true,
              evidence: [{ path: 'packages/ui/src/App.tsx', line: 8 }],
            },
          ],
          neighboursTotal: 1,
          neighboursTruncated: false,
        },
      ],
      filesTotal: 2,
      filesOmitted: 0,
      modules: [
        {
          repository: '/repo',
          module: {
            id: 'module:package.json:packages/daemon',
            name: '@salidium/daemon',
            manifest: 'packages/daemon/package.json',
            ecosystem: 'npm',
          },
          changedFiles: ['packages/daemon/src/daemon.ts'],
          dependents: [
            {
              module: {
                id: 'module:package.json:packages/cli',
                name: 'salidium',
                manifest: 'packages/cli/package.json',
                ecosystem: 'npm',
              },
              edge: 'e:0000000000000005',
              provenance: 'observed',
              rule: 'package-json-dependency',
            },
          ],
          dependentsTotal: 1,
          dependentsTruncated: false,
        },
      ],
      mapElementsWithheld: 0,
      modulesTruncated: false,
    };

    const html = renderToStaticMarkup(
      <SessionCanvas
        view={view}
        sessionId="sess-1"
        provider="claude-code"
        cwd="/repo"
        displayedExplanation={undefined}
        showingPersonalized={false}
        hasAlternate={false}
        personalizerOpen={false}
        onClosePersonalizer={() => {}}
        hasCurrentPresentation={false}
        explanationStatus="disabled"
        explanationCadence="off"
        lens="system"
        executionLinks={links}
        onRef={() => {}}
      />,
    );

    expect(html).toContain('Code Map &amp; Impact');
    expect(html).toContain('a1b2c3d');
    expect(html).toContain('Latest Turn End');
    expect(html).toContain('Imports (2)');
    expect(html).toContain('1 file · 1 pkg');
    expect(html).toContain('Edited Files (2)');
    expect(html).toContain('1 Linked Edit');
    expect(html).toContain('packages/ui/src/App.tsx');
    expect(html).toContain('packages/daemon/src/store.ts');
    expect(html).not.toContain('workspace-export');
    expect(html).not.toContain('L8');
    expect(html).toContain('↳ daemon.ts');
    expect(html).toContain('↑ App.tsx');
    expect(html).toContain('@salidium/core');
    expect(html).toContain('Dependents &amp; Tests (2)');
    expect(html).toContain('1 Unedited Caller');
    expect(html).toContain('packages/daemon/src/daemon.test.ts');
    expect(html).toContain('Test Suite');
    expect(html).toContain('Dependent Package');
    expect(html).toContain('packages/cli/package.json');
    expect(html).not.toContain('package-json-dependency');
  });

  it('renders unmapped repository opt-in action in the System lens when project-map is not yet allowed', () => {
    const view = makeSessionView();
    const links: ExecutionLinks = {
      format: 'salidium.execution-links',
      version: 0,
      experimental: true,
      sessionId: 'sess-1',
      generatedAt: '2026-04-01T12:05:30.000Z',
      anchors: {
        atStart: null,
        atLatestTurnEnd: null,
      },
      repositories: [
        {
          root: '/repo',
          worktrees: ['/repo'],
          status: 'not-opted-in',
          unavailable: null,
          commit: null,
          commitTime: null,
          mapComplete: null,
        },
      ],
      files: [
        {
          path: '/repo/packages/daemon/src/daemon.ts',
          relativePath: 'packages/daemon/src/daemon.ts',
          repository: '/repo',
          worktree: '/repo',
          status: 'repository-not-mapped',
          node: null,
          role: null,
          modules: [],
          neighbours: [],
          neighboursTotal: 0,
          neighboursTruncated: false,
        },
      ],
      filesTotal: 1,
      filesOmitted: 0,
      modules: [],
      mapElementsWithheld: 0,
      modulesTruncated: false,
    };

    const html = renderToStaticMarkup(
      <SessionCanvas
        view={view}
        sessionId="sess-1"
        provider="claude-code"
        cwd="/repo"
        displayedExplanation={undefined}
        showingPersonalized={false}
        hasAlternate={false}
        personalizerOpen={false}
        onClosePersonalizer={() => {}}
        hasCurrentPresentation={false}
        explanationStatus="disabled"
        explanationCadence="off"
        lens="system"
        executionLinks={links}
        onAllowRepository={() => {}}
        onRef={() => {}}
      />,
    );

    expect(html).toContain('Salidium has not been allowed to read this repository, so it has not.');
    expect(html).toContain('Allow Repository');
    expect(html).toContain('salidium map allow /repo');
  });

  it('promotes 0. Failure Causal Chain via salidium.canvas-spec/v1 when a verification check fails', () => {
    const view = makeSessionView();
    view.verified.runs.push({
      id: 'ver-fail-1',
      callId: 'call-fail-test',
      at: '2026-04-01T12:04:00.000Z',
      label: '1/15 tests failed (vitest)',
      method: 'test',
      runner: 'vitest',
      outcome: 'fail',
      counts: { passed: 14, failed: 1, total: 15 },
      scope: 'full',
      exit: { code: 1, epistemic: 'observed' },
      epistemic: 'observed',
      caveats: [],
      stale: false,
      command: 'npx vitest run',
      failureExcerpt: 'AssertionError: expected SessionCanvas to include blast-radius edge',
      turnIndex: 2,
    });

    const html = renderToStaticMarkup(
      <SessionCanvas
        view={view}
        sessionId="sess-1"
        provider="claude-code"
        cwd="/repo"
        displayedExplanation={undefined}
        showingPersonalized={false}
        hasAlternate={false}
        personalizerOpen={false}
        onClosePersonalizer={() => {}}
        hasCurrentPresentation={false}
        explanationStatus="disabled"
        explanationCadence="off"
        lens="system"
        onRef={() => {}}
      />,
    );

    expect(html).toContain('data-dil-block="failure-chain"');
    expect(html).toContain('Failing Check');
    expect(html).toContain('1. Edited Before Failure');
    expect(html).toContain('2. Failing Command');
    expect(html).toContain('3. Error Output');
    expect(html).toContain('AssertionError: expected SessionCanvas to include blast-radius edge');
  });

  it('applies direct Webflow-style canvas layout, surface, connector, and block visibility controls', () => {
    const view = makeSessionView();
    useAppStore.getState().updateCanvasStyleConfig({
      fillMode: 'gradient',
      canvasBgPrimary: '#182436',
      canvasBgSecondary: '#0f1722',
      cardBgColor: '#1e2c42',
      cardBgOpacity: 82,
      cardBlurPx: 18,
      cornerRadiusPx: 20,
      cardPaddingPx: 22,
      cardGapPx: 14,
      connectorStyle: 'step',
      connectorColor: '#5899e2',
      connectorWidthPx: 2,
      sectionMarker: 'number',
      sections: {
        ...DEFAULT_CANVAS_STYLE_CONFIG.sections,
        checksAndReview: false,
      },
    });

    const html = renderToStaticMarkup(
      <SessionCanvas
        view={view}
        sessionId="sess-1"
        provider="claude-code"
        cwd="/repo"
        displayedExplanation={undefined}
        showingPersonalized={false}
        hasAlternate={false}
        personalizerOpen={false}
        onClosePersonalizer={() => {}}
        hasCurrentPresentation={false}
        explanationStatus="disabled"
        explanationCadence="off"
        onRef={() => {}}
      />,
    );

    expect(html).toContain('data-section-marker="number"');
    expect(html).toContain('data-connector-style="step"');
    expect(html).toContain('--custom-radius:20px');
    expect(html).toContain('--custom-card-blur:18px');
    expect(html).toContain('Customize');
    // Verification block hidden via direct layout toggle
    expect(html).not.toContain('Checks &amp; Review');
    // No hardcoded preset names
    expect(html).not.toContain('Noveuis Mist');
    expect(html).not.toContain('Obsidian Cosmos');

    expect(buildConnectorPath('step', 0, 10, 100, 50)).toBe('M 0 10 L 50 10 L 50 50 L 100 50');
    expect(buildConnectorPath('straight', 0, 10, 100, 50)).toBe('M 0 10 L 100 50');

    const vars = canvasStyleToInlineVars(useAppStore.getState().canvasStyleConfig);
    expect(vars['--custom-radius']).toBe('20px');
    expect(vars['--custom-card-blur']).toBe('18px');
  });

  it('enforces perceptual contrast guardrails across all 3 elevation tiers for white-on-white and dark-on-dark configs', () => {
    const whiteOnWhite = canvasStyleToInlineVars({
      ...DEFAULT_CANVAS_STYLE_CONFIG,
      canvasBgPrimary: '#ffffff',
      cardBgColor: '#ffffff',
      cardBgOpacity: 100,
      borderColor: '#ffffff',
      borderWidthPx: 0,
      textColor: '#f5f5f5',
      mutedTextColor: '#eeeeee',
    });

    // Even when borderWidthPx is 0, effective hairline border width is preserved
    expect(whiteOnWhite['--custom-border-width']).toBe('0.75px');
    // Card fill is nudged off pure #ffffff so Tier 1 is distinct from Tier 0
    expect(whiteOnWhite['--custom-card-bg']).not.toBe('rgba(255, 255, 255, 1.00)');

    const tier2Rgb = parseHexRgb(whiteOnWhite['--custom-card-subtle-bg'] ?? '');
    const borderRgb = parseHexRgb(whiteOnWhite['--custom-border-color'] ?? '');
    const innerBorderRgb = parseHexRgb(whiteOnWhite['--custom-inner-border-color'] ?? '');
    const textRgb = parseHexRgb(whiteOnWhite['--custom-text-color'] ?? '');
    const mutedRgb = parseHexRgb(whiteOnWhite['--custom-muted-color'] ?? '');
    expect(tier2Rgb).not.toBeNull();
    expect(borderRgb).not.toBeNull();
    expect(innerBorderRgb).not.toBeNull();
    expect(textRgb).not.toBeNull();
    expect(mutedRgb).not.toBeNull();

    if (tier2Rgb && innerBorderRgb && textRgb && mutedRgb) {
      expect(contrastRatio(innerBorderRgb, tier2Rgb)).toBeGreaterThanOrEqual(1.3);
      expect(contrastRatio(textRgb, tier2Rgb)).toBeGreaterThanOrEqual(4.2);
      expect(contrastRatio(mutedRgb, tier2Rgb)).toBeGreaterThanOrEqual(2.8);
    }

    const darkOnDark = canvasStyleToInlineVars({
      ...DEFAULT_CANVAS_STYLE_CONFIG,
      canvasBgPrimary: '#0d1117',
      cardBgColor: '#0d1117',
      cardBgOpacity: 100,
      borderColor: '#0d1117',
      textColor: '#111827',
    });
    const darkTier2Rgb = parseHexRgb(darkOnDark['--custom-card-subtle-bg'] ?? '');
    const darkTextRgb = parseHexRgb(darkOnDark['--custom-text-color'] ?? '');
    expect(darkTier2Rgb).not.toBeNull();
    expect(darkTextRgb).not.toBeNull();
    if (darkTier2Rgb && darkTextRgb) {
      expect(oklabLightness(darkTier2Rgb)).toBeGreaterThan(oklabLightness([13, 17, 23]) + 0.04);
      expect(contrastRatio(darkTextRgb, darkTier2Rgb)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
