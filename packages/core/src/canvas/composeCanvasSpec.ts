import type { CanvasBlock, CanvasBlockKind, CanvasSpec } from '@salidium/protocol';
import type { SessionView } from '../projections/projectSession.ts';
import type { Explanation } from '../state/runState.ts';

/**
 * Minimal structural shape of `@salidium/project-map` `ExecutionLinks` so `@salidium/core`
 * can compose blast-radius blocks without taking a circular package dependency.
 */
export interface CanvasLinksInput {
  repositories: ReadonlyArray<{
    root: string;
    status: string;
  }>;
  files: ReadonlyArray<{
    path: string;
    relativePath: string | null;
    status: string;
    neighbours: ReadonlyArray<{
      direction: 'imports' | 'imported-by';
      edge: string;
      nodeKind: string;
      path: string | null;
      name: string | null;
      changed: boolean;
    }>;
  }>;
  modules: ReadonlyArray<{
    dependents: ReadonlyArray<{
      edge: string;
      module: {
        name: string | null;
        manifest: string;
      };
    }>;
  }>;
}

export interface ComposeCanvasSpecOptions {
  links?: CanvasLinksInput | null;
  explanation?: Explanation;
}

/**
 * Collects every valid ground-truth reference ID present in the session projection and
 * optional project-map links so model-proposed `refs` can be verified against observed state.
 */
export function collectValidCanvasRefs(
  view: SessionView,
  links?: CanvasLinksInput | null,
): Set<string> {
  const valid = new Set<string>();

  for (const file of view.changes.files) {
    valid.add(`file:${file.path}`);
    if (file.lastCallId) valid.add(`call:${file.lastCallId}`);
  }
  for (const cmd of view.changes.commands) {
    valid.add(`call:${cmd.callId}`);
  }
  for (const run of view.verified.runs) {
    valid.add(`call:${run.callId}`);
  }
  for (const sub of view.subagents) {
    valid.add(`subagent:${sub.id}`);
  }
  for (const turn of view.turns) {
    valid.add(`turn:${turn.index}`);
    for (const act of turn.activities) {
      valid.add(`call:${act.callId}`);
    }
  }
  if (links) {
    for (const file of links.files) {
      if (file.relativePath) valid.add(`file:${file.relativePath}`);
      valid.add(`file:${file.path}`);
      for (const n of file.neighbours) {
        valid.add(`edge:${n.edge}`);
        if (n.path) valid.add(`file:${n.path}`);
      }
    }
    for (const mod of links.modules) {
      for (const dep of mod.dependents) {
        valid.add(`edge:${dep.edge}`);
      }
    }
  }

  return valid;
}

/**
 * Composes a `salidium.canvas-spec/v1` Declarative Interface Language (DIL) specification
 * from observed session telemetry, `@salidium/project-map` blast-radius links, and optional
 * model-generated `Explanation`.
 *
 * Guarantees:
 * 1. Constrained component primitives (`failure-chain`, `topology`, `blast-radius`,
 *    `subagent-fanout`, `turn-pipeline`, `decisions`).
 * 2. Data binding by reference (`refs`) verified against `collectValidCanvasRefs`:
 *    any unverified model reference is stripped so the UI never renders hallucinated entities.
 * 3. Deterministic signal ranking: failing checks and untouched blast-radius importers are
 *    never buried behind static tabs.
 */
export function composeCanvasSpec(
  view: SessionView,
  options: ComposeCanvasSpecOptions = {},
): CanvasSpec {
  const { links, explanation = view.explained } = options;
  const validRefs = collectValidCanvasRefs(view, links);

  const files = view.changes.files;
  const recommendedDensity: 'files' | 'modules' = files.length >= 7 ? 'modules' : 'files';

  const failingRuns = view.verified.runs.filter(
    (r) => r.outcome === 'fail' || r.outcome === 'partial',
  );
  const openAttentionGroups = view.review.groups.filter(
    (g) => g.severity === 'high' || g.severity === 'medium',
  );

  // Inspect project-map blast radius signals
  const mappedRepos = links?.repositories.filter((r) => r.status === 'mapped') ?? [];
  const linkedFiles = links?.files.filter((f) => f.status === 'linked') ?? [];
  const untouchedImporterPaths = new Set<string>();
  const coModifiedEdgeIds = new Set<string>();
  const blastEdgeIds = new Set<string>();

  for (const lf of linkedFiles) {
    for (const n of lf.neighbours) {
      blastEdgeIds.add(`edge:${n.edge}`);
      if (n.direction === 'imported-by' && n.nodeKind === 'file' && n.path) {
        if (!n.changed) untouchedImporterPaths.add(n.path);
        else coModifiedEdgeIds.add(`edge:${n.edge}`);
      }
      if (n.direction === 'imports' && n.changed) {
        coModifiedEdgeIds.add(`edge:${n.edge}`);
      }
    }
  }
  const ring2Count = links?.modules.reduce((acc, m) => acc + m.dependents.length, 0) ?? 0;
  for (const mod of links?.modules ?? []) {
    for (const dep of mod.dependents) {
      blastEdgeIds.add(`edge:${dep.edge}`);
    }
  }

  const deterministicBlocks: CanvasBlock[] = [];

  // 1. Failure Causal Chain (promoted to #1 whenever a verification gate fails)
  if (failingRuns.length > 0) {
    const unverifiedFileRefs = files
      .filter((f) => !f.verifiedAfter)
      .slice(0, 6)
      .map((f) => `file:${f.path}`);
    const checkRefs = failingRuns.slice(0, 4).map((r) => `call:${r.callId}`);
    deterministicBlocks.push({
      kind: 'failure-chain',
      priority: 'primary',
      reason: `${failingRuns.length} ${failingRuns.length === 1 ? 'check' : 'checks'} failing after ${files.length} modified ${files.length === 1 ? 'file' : 'files'}`,
      refs: [...checkRefs, ...unverifiedFileRefs].slice(0, 16),
    });
  }

  // 2. Approach Pivot / Decisions (when model explanation includes an explicit approachChange pivot)
  if (explanation?.approachChange) {
    deterministicBlocks.push({
      kind: 'decisions',
      priority: 'primary',
      reason: `Approach pivot: ${explanation.approachChange.from} -> ${explanation.approachChange.to}`,
      refs: view.turns.slice(0, 6).map((t) => `turn:${t.index}`),
    });
  }

  // 3. System & Component Topology
  const topFileRefs = files.slice(0, 12).map((f) => `file:${f.path}`);
  const unverifiedCount = files.filter((f) => !f.verifiedAfter).length;
  deterministicBlocks.push({
    kind: 'topology',
    priority: 'primary',
    reason:
      files.length > 0
        ? `${files.length} modified ${files.length === 1 ? 'file' : 'files'} · ${files.length - unverifiedCount}/${files.length} verified`
        : `${view.turns.length} ${view.turns.length === 1 ? 'turn' : 'turns'} · ${view.changes.commands.length} ${view.changes.commands.length === 1 ? 'command' : 'commands'}`,
    refs: topFileRefs,
    density: recommendedDensity,
  });

  // 4. Dependency Edges & Blast Radius
  if (mappedRepos.length > 0 && (blastEdgeIds.size > 0 || ring2Count > 0)) {
    const untouchedCount = untouchedImporterPaths.size;
    const reasonParts: string[] = [];
    if (untouchedCount > 0) {
      reasonParts.push(
        `${untouchedCount} untouched ${untouchedCount === 1 ? 'importer' : 'importers'}`,
      );
    }
    if (coModifiedEdgeIds.size > 0) {
      reasonParts.push(
        `${coModifiedEdgeIds.size} co-modified ${coModifiedEdgeIds.size === 1 ? 'edge' : 'edges'}`,
      );
    }
    if (ring2Count > 0) {
      reasonParts.push(`${ring2Count} Ring 2 ${ring2Count === 1 ? 'module' : 'modules'}`);
    }
    if (reasonParts.length === 0) {
      reasonParts.push(
        `${blastEdgeIds.size} dependency ${blastEdgeIds.size === 1 ? 'edge' : 'edges'}`,
      );
    }

    deterministicBlocks.push({
      kind: 'blast-radius',
      priority: untouchedCount > 0 || coModifiedEdgeIds.size > 0 ? 'primary' : 'secondary',
      reason: reasonParts.join(' · '),
      refs: [
        ...[...untouchedImporterPaths].slice(0, 8).map((p) => `file:${p}`),
        ...[...blastEdgeIds].slice(0, 8),
      ].slice(0, 16),
    });
  }

  // 5. Subagent Fan-Out Tree
  if (view.subagents.length > 0) {
    const totalCalls = view.subagents.reduce((sum, s) => sum + s.toolCalls, 0);
    deterministicBlocks.push({
      kind: 'subagent-fanout',
      priority: view.subagents.length >= 2 ? 'primary' : 'secondary',
      reason: `${view.subagents.length} delegated ${view.subagents.length === 1 ? 'subagent' : 'subagents'} · ${totalCalls} tool ${totalCalls === 1 ? 'call' : 'calls'}`,
      refs: view.subagents.slice(0, 12).map((s) => `subagent:${s.id}`),
    });
  }

  // 6. Turn Execution Pipeline
  if (view.turns.length > 0) {
    deterministicBlocks.push({
      kind: 'turn-pipeline',
      priority: view.turns.length >= 2 ? 'primary' : 'secondary',
      reason: `${view.turns.length} ${view.turns.length === 1 ? 'turn' : 'turns'} across Explore, Mutate, and Verify phases`,
      refs: view.turns.slice(0, 12).map((t) => `turn:${t.index}`),
    });
  }

  // 7. Decisions (when not already promoted at #2)
  if (!explanation?.approachChange) {
    deterministicBlocks.push({
      kind: 'decisions',
      priority: explanation ? 'primary' : 'secondary',
      reason: explanation
        ? `Causal Why & How (${explanation.why.chain.length} ${explanation.why.chain.length === 1 ? 'step' : 'steps'})`
        : openAttentionGroups.length > 0
          ? `${openAttentionGroups.length} review ${openAttentionGroups.length === 1 ? 'group' : 'groups'} open`
          : 'Observed causal progression',
      refs: view.turns.slice(0, 6).map((t) => `turn:${t.index}`),
    });
  }

  // If the model supplied `canvasBlocks`, validate all refs against ground truth and merge
  let finalBlocks = deterministicBlocks;
  let composer: 'deterministic' | 'model' = 'deterministic';

  if (explanation?.canvasBlocks && explanation.canvasBlocks.length > 0) {
    composer = 'model';
    const seen = new Set<CanvasBlockKind>();
    const sanitizedModelBlocks: CanvasBlock[] = [];

    // Safety invariant: if a verification check is failing, `failure-chain` stays visible
    if (
      failingRuns.length > 0 &&
      !explanation.canvasBlocks.some((b) => b.kind === 'failure-chain')
    ) {
      const failBlock = deterministicBlocks.find((b) => b.kind === 'failure-chain');
      if (failBlock) {
        sanitizedModelBlocks.push(failBlock);
        seen.add('failure-chain');
      }
    }

    for (const block of explanation.canvasBlocks) {
      if (seen.has(block.kind)) continue;
      seen.add(block.kind);
      const verifiedRefs = block.refs.filter((r) => validRefs.has(r));
      const fallbackBlock = deterministicBlocks.find((b) => b.kind === block.kind);
      sanitizedModelBlocks.push({
        kind: block.kind,
        priority: block.priority,
        reason: block.reason,
        refs: verifiedRefs.length > 0 ? verifiedRefs : (fallbackBlock?.refs ?? []),
        ...(block.density ? { density: block.density } : {}),
      });
    }

    for (const det of deterministicBlocks) {
      if (sanitizedModelBlocks.length >= 6) break;
      if (!seen.has(det.kind)) {
        seen.add(det.kind);
        sanitizedModelBlocks.push(det);
      }
    }

    if (sanitizedModelBlocks.length > 0) {
      finalBlocks = sanitizedModelBlocks.slice(0, 6);
    }
  } else {
    finalBlocks = deterministicBlocks.slice(0, 6);
  }

  // Derive a zero-filler headline summarizing the session's dominant structural shape
  const headlineParts: string[] = [];
  if (failingRuns.length > 0) {
    headlineParts.push(
      `${failingRuns.length} Failing ${failingRuns.length === 1 ? 'Check' : 'Checks'}`,
    );
  } else if (files.length > 0) {
    headlineParts.push(`${files.length} Modified ${files.length === 1 ? 'File' : 'Files'}`);
  } else {
    headlineParts.push(`${view.turns.length} ${view.turns.length === 1 ? 'Turn' : 'Turns'}`);
  }

  if (untouchedImporterPaths.size > 0) {
    headlineParts.push(
      `${untouchedImporterPaths.size} Untouched ${untouchedImporterPaths.size === 1 ? 'Importer' : 'Importers'}`,
    );
  } else if (coModifiedEdgeIds.size > 0) {
    headlineParts.push(
      `${coModifiedEdgeIds.size} Co-Modified ${coModifiedEdgeIds.size === 1 ? 'Edge' : 'Edges'}`,
    );
  }

  if (view.subagents.length > 0) {
    headlineParts.push(
      `${view.subagents.length} ${view.subagents.length === 1 ? 'Subagent' : 'Subagents'}`,
    );
  }

  return {
    format: 'salidium.canvas-spec/v1',
    composer,
    ...(composer === 'model' && explanation ? { model: explanation.model } : {}),
    headline: headlineParts.join(' · '),
    recommendedDensity,
    blocks: finalBlocks,
  };
}
