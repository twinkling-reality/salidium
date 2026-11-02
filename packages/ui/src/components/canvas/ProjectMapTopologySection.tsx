import type { FileRow } from '@salidium/core';
import type { ExecutionLinks, FileLink, ModuleLink, Neighbour } from '@salidium/project-map';
import { useMemo, useState } from 'react';
import { basename, dirname, shortHome, shortPath } from '../../lib/format.ts';
import { buildConnectorPath, type CanvasStyleConfig } from '../../lib/visualPresets.ts';
import {
  COMMIT_CHOSEN_WORDS,
  describeRepositoryStatus,
  EDGE_KIND_WORDS,
  shellWord,
  UNLINKED_FILE_WORDS,
} from '../WhereItSits.tsx';

interface OutboundDependencyEdge {
  edge: string;
  fromPath: string;
  fromCallId?: string;
  toPath: string;
  toCallId?: string;
  changed: boolean;
  kind: Neighbour['kind'];
  rule: string;
  line?: number | null;
  role: Neighbour['role'];
}

interface BlastRadiusImporter {
  path: string;
  callId?: string;
  changed: boolean;
  role: Neighbour['role'];
  importedTargets: Array<{
    targetPath: string;
    targetCallId?: string;
    kind: Neighbour['kind'];
    rule: string;
    line?: number | null;
  }>;
}

const NODE_H = 58;
const NODE_GAP = 10;
const ROW_PITCH = NODE_H + NODE_GAP;

function DepNodePath({ path }: { path: string }) {
  if (path.startsWith('@')) {
    return <span className="dep-node-base">{path}</span>;
  }
  const base = basename(path);
  const rawDir = dirname(path).replace(/^\.$/, '');
  const compactDir = rawDir.replace(/^packages\//, '');
  if (!compactDir || compactDir === path) {
    return <span className="dep-node-base">{path}</span>;
  }
  return (
    <>
      <span className="dep-node-base">{base}</span>
      <span className="dep-node-dir">{compactDir}</span>
    </>
  );
}

export function ProjectMapTopologySection({
  links,
  files,
  cwd,
  styleConfig,
  sectionIndex,
  onRef,
  onRetry,
  onAllowRepository,
  allowingRepository,
  allowError,
}: {
  links: ExecutionLinks;
  files: FileRow[];
  cwd: string;
  styleConfig: CanvasStyleConfig;
  sectionIndex: string;
  onRef: (ref: string) => void;
  onRetry?: () => void;
  onAllowRepository?: (root: string) => void;
  allowingRepository?: string;
  allowError?: string;
}) {
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  const topology = useMemo(() => {
    const mappedRepos = links.repositories.filter((r) => r.status === 'mapped');
    const unmappedRepos = links.repositories.filter((r) => r.status !== 'mapped');
    const linkedFiles = links.files.filter((f) => f.status === 'linked');

    const callIdByPath = new Map<string, string>();
    for (const row of files) {
      callIdByPath.set(row.path, row.lastCallId);
      callIdByPath.set(shortPath(row.path, cwd).replace(/^\.\//, ''), row.lastCallId);
    }
    for (const lf of linkedFiles) {
      const callId = callIdByPath.get(lf.path);
      if (callId && lf.relativePath) {
        callIdByPath.set(lf.relativePath, callId);
      }
    }

    const outboundEdges: OutboundDependencyEdge[] = [];
    const seenOutbound = new Set<string>();
    const importersByPath = new Map<string, BlastRadiusImporter>();

    for (const file of linkedFiles) {
      const sourcePath = file.relativePath ?? shortPath(file.path, cwd);
      const sourceCallId = callIdByPath.get(file.path) ?? callIdByPath.get(sourcePath);

      for (const n of file.neighbours) {
        if (n.direction === 'imports') {
          if (n.nodeKind === 'file') {
            if (seenOutbound.has(n.edge)) continue;
            seenOutbound.add(n.edge);
            const toPath = n.path ?? n.name ?? n.node;
            outboundEdges.push({
              edge: n.edge,
              fromPath: sourcePath,
              fromCallId: sourceCallId,
              toPath,
              toCallId: callIdByPath.get(toPath),
              changed: n.changed,
              kind: n.kind,
              rule: n.rule,
              line: n.evidence[0]?.line,
              role: n.role,
            });
          }
        } else if (n.direction === 'imported-by' && n.nodeKind === 'file') {
          const importerPath = n.path ?? n.name ?? n.node;
          const existing = importersByPath.get(importerPath);
          const targetEntry = {
            targetPath: sourcePath,
            targetCallId: sourceCallId,
            kind: n.kind,
            rule: n.rule,
            line: n.evidence[0]?.line,
          };
          if (existing) {
            if (!existing.importedTargets.some((t) => t.targetPath === sourcePath)) {
              existing.importedTargets.push(targetEntry);
            }
          } else {
            importersByPath.set(importerPath, {
              path: importerPath,
              callId: callIdByPath.get(importerPath),
              changed: n.changed,
              role: n.role,
              importedTargets: [targetEntry],
            });
          }
        }
      }
    }

    outboundEdges.sort((a, b) => Number(b.changed) - Number(a.changed));
    const importers = [...importersByPath.values()].sort(
      (a, b) => Number(a.changed) - Number(b.changed),
    );
    const coModifiedEdgesCount = outboundEdges.filter((e) => e.changed).length;
    const dependentModules: Array<{
      sourceModule: ModuleLink['module'];
      dependent: ModuleLink['dependents'][number];
    }> = [];
    for (const mod of links.modules) {
      for (const dep of mod.dependents) {
        dependentModules.push({ sourceModule: mod.module, dependent: dep });
      }
    }

    const linkedByRelPath = new Map<string, FileLink>();
    for (const lf of linkedFiles) {
      const rel = lf.relativePath ?? shortPath(lf.path, cwd).replace(/^\.\//, '');
      linkedByRelPath.set(rel, lf);
      linkedByRelPath.set(lf.path, lf);
    }

    const allEditedCandidates: Array<{
      relPath: string;
      fileRow?: FileRow;
      linkedFile?: FileLink;
    }> = [];
    const seenEditedPaths = new Set<string>();

    for (const lf of linkedFiles) {
      const relPath = lf.relativePath ?? shortPath(lf.path, cwd).replace(/^\.\//, '');
      if (seenEditedPaths.has(relPath)) continue;
      seenEditedPaths.add(relPath);
      const fileRow = files.find(
        (f) => f.path === lf.path || shortPath(f.path, cwd).replace(/^\.\//, '') === relPath,
      );
      allEditedCandidates.push({ relPath, fileRow, linkedFile: lf });
    }
    for (const f of files) {
      const relPath = shortPath(f.path, cwd).replace(/^\.\//, '');
      if (seenEditedPaths.has(relPath)) continue;
      seenEditedPaths.add(relPath);
      allEditedCandidates.push({
        relPath,
        fileRow: f,
        linkedFile: linkedByRelPath.get(relPath) ?? linkedByRelPath.get(f.path),
      });
    }

    const editedPathSet = new Set(allEditedCandidates.map((c) => c.relPath));

    const modifiedNodes = allEditedCandidates.slice(0, 8).map((item, idx) => {
      const { relPath, fileRow, linkedFile } = item;
      const callId =
        fileRow?.lastCallId ??
        (linkedFile ? callIdByPath.get(linkedFile.path) : undefined) ??
        callIdByPath.get(relPath);
      const mod = linkedFile?.modules[0]?.module;
      const usesEditedPeers = outboundEdges
        .filter((e) => e.fromPath === relPath && (e.changed || editedPathSet.has(e.toPath)))
        .map((e) => e.toPath);
      const usedByEditedPeers = outboundEdges
        .filter((e) => e.toPath === relPath && (e.changed || editedPathSet.has(e.fromPath)))
        .map((e) => e.fromPath);
      return {
        id: `mod:${relPath}`,
        index: idx,
        path: relPath,
        callId,
        verified: fileRow?.verifiedAfter ?? false,
        linesAdded: fileRow?.linesAdded ?? 0,
        linesRemoved: fileRow?.linesRemoved ?? 0,
        modName: mod?.name ?? mod?.manifest,
        usesEditedPeers,
        usedByEditedPeers,
      };
    });
    const modIndexByPath = new Map(modifiedNodes.map((n) => [n.path, n.index]));

    const rawUpstreamNodes: Array<{
      id: string;
      kind: 'file' | 'pkg';
      path: string;
      callId?: string;
      role: OutboundDependencyEdge['role'];
      edgeKind?: Neighbour['kind'];
      fromPaths: string[];
    }> = [];
    const upstreamByKey = new Map<string, (typeof rawUpstreamNodes)[number]>();

    // Enforce strict 1-node-per-file identity: exclude files already in Edited in Session
    for (const edge of outboundEdges) {
      if (edge.changed || editedPathSet.has(edge.toPath)) continue;
      const key = `file:${edge.toPath}`;
      const existing = upstreamByKey.get(key);
      if (existing) {
        if (!existing.fromPaths.includes(edge.fromPath)) existing.fromPaths.push(edge.fromPath);
      } else if (rawUpstreamNodes.length < 8) {
        const node = {
          id: key,
          kind: 'file' as const,
          path: edge.toPath,
          callId: edge.toCallId,
          role: edge.role,
          edgeKind: edge.kind,
          fromPaths: [edge.fromPath],
        };
        rawUpstreamNodes.push(node);
        upstreamByKey.set(key, node);
      }
    }
    for (const file of linkedFiles) {
      const sourcePath = file.relativePath ?? shortPath(file.path, cwd);
      for (const n of file.neighbours) {
        if (n.direction === 'imports' && n.nodeKind !== 'file') {
          const pkgName = n.name ?? n.node;
          const key = `pkg:${pkgName}`;
          const existing = upstreamByKey.get(key);
          if (existing) {
            if (!existing.fromPaths.includes(sourcePath)) existing.fromPaths.push(sourcePath);
          } else if (rawUpstreamNodes.length < 8) {
            const node = {
              id: key,
              kind: 'pkg' as const,
              path: pkgName,
              role: null,
              edgeKind: n.kind,
              fromPaths: [sourcePath],
            };
            rawUpstreamNodes.push(node);
            upstreamByKey.set(key, node);
          }
        }
      }
    }

    const barycenter = (paths: string[]) => {
      const idxs = paths
        .map((p) => modIndexByPath.get(p))
        .filter((i): i is number => i !== undefined);
      if (idxs.length === 0) return 999;
      return idxs.reduce((a, b) => a + b, 0) / idxs.length;
    };

    const upstreamNodes = rawUpstreamNodes
      .sort((a, b) => barycenter(a.fromPaths) - barycenter(b.fromPaths))
      .map((node, index) => ({ ...node, index }));

    const rawBlastNodes: Array<{
      id: string;
      kind: 'ring1' | 'ring2';
      path: string;
      sub?: string;
      callId?: string;
      role: BlastRadiusImporter['role'];
      edgeKind?: Neighbour['kind'];
      targetPaths: string[];
    }> = [];

    // Enforce strict 1-node-per-file identity: only unedited downstream files & tests
    for (const imp of importers) {
      if (imp.changed || editedPathSet.has(imp.path)) continue;
      if (rawBlastNodes.length >= 8) break;
      const first = imp.importedTargets[0];
      rawBlastNodes.push({
        id: `imp:${imp.path}`,
        kind: 'ring1',
        path: imp.path,
        callId: imp.callId,
        role: imp.role,
        edgeKind: first?.kind,
        targetPaths: imp.importedTargets.map((t) => t.targetPath),
      });
    }
    for (const { sourceModule, dependent } of dependentModules.slice(
      0,
      Math.max(0, 8 - rawBlastNodes.length),
    )) {
      const matchedModPaths = modifiedNodes
        .filter((m) => m.modName === (sourceModule.name ?? sourceModule.manifest))
        .map((m) => m.path)
        .slice(0, 1);
      rawBlastNodes.push({
        id: `ring2:${dependent.edge}`,
        kind: 'ring2',
        path: dependent.module.name ?? dependent.module.manifest,
        sub: dependent.module.manifest,
        role: null,
        targetPaths:
          matchedModPaths.length > 0
            ? matchedModPaths
            : modifiedNodes.slice(0, 1).map((m) => m.path),
      });
    }

    const blastNodes = rawBlastNodes
      .sort((a, b) => barycenter(a.targetPaths) - barycenter(b.targetPaths))
      .map((node, index) => ({ ...node, index }));

    const leftSvgEdges: Array<{
      key: string;
      upId: string;
      modId: string;
      yUp: number;
      yMod: number;
    }> = [];
    for (const up of upstreamNodes) {
      for (const fromPath of up.fromPaths) {
        const mIdx = modIndexByPath.get(fromPath);
        if (mIdx === undefined) continue;
        const yUp = up.index * ROW_PITCH + NODE_H / 2;
        const yMod = mIdx * ROW_PITCH + NODE_H / 2;
        leftSvgEdges.push({
          key: `${up.id}->${fromPath}`,
          upId: up.id,
          modId: `mod:${fromPath}`,
          yUp,
          yMod,
        });
      }
    }

    const rightSvgEdges: Array<{
      key: string;
      blastId: string;
      modId: string;
      yBlast: number;
      yMod: number;
      isTest: boolean;
    }> = [];
    for (const bn of blastNodes) {
      for (const targetPath of bn.targetPaths) {
        const mIdx = modIndexByPath.get(targetPath);
        if (mIdx === undefined) continue;
        const yBlast = bn.index * ROW_PITCH + NODE_H / 2;
        const yMod = mIdx * ROW_PITCH + NODE_H / 2;
        rightSvgEdges.push({
          key: `${targetPath}->${bn.id}`,
          blastId: bn.id,
          modId: `mod:${targetPath}`,
          yBlast,
          yMod,
          isTest: Boolean(bn.role),
        });
      }
    }

    return {
      mappedRepos,
      unmappedRepos,
      modifiedNodes,
      upstreamNodes,
      blastNodes,
      leftSvgEdges,
      rightSvgEdges,
      coModifiedEdgesCount,
    };
  }, [links, files, cwd]);

  const {
    mappedRepos,
    unmappedRepos,
    modifiedNodes,
    upstreamNodes,
    blastNodes,
    leftSvgEdges,
    rightSvgEdges,
    coModifiedEdgesCount,
  } = topology;

  const connectedToHovered = useMemo(() => {
    const connected = new Set<string>();
    if (!hoveredNode) return connected;
    connected.add(hoveredNode);
    for (const e of leftSvgEdges) {
      if (e.upId === hoveredNode || e.modId === hoveredNode) {
        connected.add(e.upId);
        connected.add(e.modId);
      }
    }
    for (const e of rightSvgEdges) {
      if (e.blastId === hoveredNode || e.modId === hoveredNode) {
        connected.add(e.blastId);
        connected.add(e.modId);
      }
    }
    for (const m of modifiedNodes) {
      if (m.id === hoveredNode) {
        for (const peer of [...m.usesEditedPeers, ...m.usedByEditedPeers]) {
          connected.add(`mod:${peer}`);
        }
      }
    }
    return connected;
  }, [hoveredNode, leftSvgEdges, rightSvgEdges, modifiedNodes]);

  const nodeTraceClass = (id: string) =>
    !hoveredNode ? '' : connectedToHovered.has(id) ? 'is-traced' : 'is-dimmed';

  const maxRows = Math.max(1, upstreamNodes.length, modifiedNodes.length, blastNodes.length);
  const svgHeight = maxRows * ROW_PITCH - NODE_GAP;
  const hasUpstream = upstreamNodes.length > 0;
  const hasDownstream = blastNodes.length > 0;
  const upstreamFileCount = upstreamNodes.filter((n) => n.kind === 'file').length;
  const upstreamPkgCount = upstreamNodes.filter((n) => n.kind === 'pkg').length;
  const upstreamTitle =
    upstreamFileCount > 0 && upstreamPkgCount === 0
      ? `Imported Files (${upstreamNodes.length})`
      : upstreamPkgCount > 0 && upstreamFileCount === 0
        ? `Imported Packages (${upstreamNodes.length})`
        : `Imports (${upstreamNodes.length})`;
  const upstreamMeta =
    upstreamFileCount > 0 && upstreamPkgCount > 0
      ? `${upstreamFileCount} ${upstreamFileCount === 1 ? 'file' : 'files'} · ${upstreamPkgCount} ${upstreamPkgCount === 1 ? 'pkg' : 'pkgs'}`
      : 'Used by edits';

  const testBlastCount = blastNodes.filter((n) => Boolean(n.role)).length;
  const callerBlastCount = blastNodes.length - testBlastCount;
  const downstreamTitle =
    testBlastCount > 0 && callerBlastCount === 0
      ? `Related Tests (${blastNodes.length})`
      : callerBlastCount > 0 && testBlastCount === 0
        ? `Dependents (${blastNodes.length})`
        : `Dependents & Tests (${blastNodes.length})`;

  const gridShapeClass =
    hasUpstream && hasDownstream
      ? ''
      : hasUpstream && !hasDownstream
        ? 'is-two-col-left'
        : !hasUpstream && hasDownstream
          ? 'is-two-col-right'
          : 'is-one-col';

  return (
    <section className="sys-topology" aria-label="Code map and impact">
      <div className="sys-topology-head">
        <h3 className="sys-tier-title" data-index={sectionIndex}>
          Code Map &amp; Impact
        </h3>
        {mappedRepos.length > 0 && (
          <div className="sys-repo-anchors">
            {mappedRepos.map((repo) => (
              <span key={repo.root} className="sys-repo-anchor">
                <bdi className="mono" title={repo.root}>
                  {shortHome(repo.root)}
                </bdi>
                {repo.commit && (
                  <>
                    {' · '}
                    <span className="mono" title={repo.commit.id}>
                      {repo.commit.id.slice(0, 7)}
                    </span>
                    {' · '}
                    <span className="where-quiet">{COMMIT_CHOSEN_WORDS[repo.commit.chosen]}</span>
                    {' · '}
                    <span
                      className="rp-derived"
                      title="Salidium read this commit while the session ran"
                    >
                      Observed
                    </span>
                  </>
                )}
              </span>
            ))}
          </div>
        )}
      </div>

      {mappedRepos.some((r) => r.mapComplete === false) && (
        <p className="rp-caveat">
          The map stopped at a size bound, so a missing link here means unknown, not none.
        </p>
      )}

      {mappedRepos.length > 0 && (
        <div className={`sys-topology-grid dep-graph-board ${gridShapeClass}`}>
          {hasUpstream && (
            <>
              {/* Column 1: Dynamically Derived Upstream Imports */}
              <div className="sys-topology-col is-edges">
                <div className="sys-topology-col-head">
                  <h4 className="sys-stack-label">{upstreamTitle}</h4>
                  <span className="where-quiet mono">{upstreamMeta}</span>
                </div>

                <ul className="dep-node-list">
                  {upstreamNodes.map((node) => (
                    <li
                      key={node.id}
                      className={`dep-node-card ${nodeTraceClass(node.id)}`}
                      onMouseEnter={() => setHoveredNode(node.id)}
                      onMouseLeave={() => setHoveredNode(null)}
                    >
                      <div className="dep-node-top">
                        {node.callId ? (
                          <button
                            type="button"
                            className="sys-edge-node is-btn mono"
                            onClick={() => node.callId && onRef(node.callId)}
                            title={node.path}
                          >
                            <DepNodePath path={node.path} />
                          </button>
                        ) : (
                          <span className="sys-edge-node mono" title={node.path}>
                            <DepNodePath path={node.path} />
                          </span>
                        )}
                      </div>
                      <div className="sys-edge-badges">
                        {node.kind === 'pkg' ? (
                          <span className="where-quiet">Package</span>
                        ) : (
                          <span className="where-quiet">File</span>
                        )}
                        {node.edgeKind && EDGE_KIND_WORDS[node.edgeKind] && (
                          <span className="where-quiet">{EDGE_KIND_WORDS[node.edgeKind]}</span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>

              {/* SVG Gutter 1: Clean Left-to-Right Curves (Imports -> Edited Files) */}
              <div className="dep-svg-col" aria-hidden="true">
                <div className="dep-svg-col-spacer" />
                <svg
                  className="dep-svg-gutter"
                  viewBox={`0 0 88 ${svgHeight}`}
                  style={{ height: svgHeight }}
                  fill="none"
                  aria-hidden="true"
                >
                  {leftSvgEdges.map((edge) => {
                    const traced =
                      hoveredNode !== null &&
                      (hoveredNode === edge.upId || hoveredNode === edge.modId);
                    const dimmed = hoveredNode !== null && !traced;
                    const strokeColor = traced
                      ? 'var(--custom-accent-color, var(--accent))'
                      : 'var(--custom-connector-color, var(--border-strong))';
                    const sw = traced
                      ? String(styleConfig.connectorWidthPx + 0.65)
                      : String(styleConfig.connectorWidthPx);
                    return (
                      <g
                        key={`curve-${edge.key}`}
                        className={`dep-svg-edge ${traced ? 'is-traced' : ''} ${dimmed ? 'is-dimmed' : ''}`}
                      >
                        <circle cx="5" cy={edge.yUp} r="2.4" fill={strokeColor} />
                        <path
                          d={buildConnectorPath(
                            styleConfig.connectorStyle,
                            5,
                            edge.yUp,
                            82,
                            edge.yMod,
                          )}
                          stroke={strokeColor}
                          strokeWidth={sw}
                        />
                        <path
                          d={`M 77 ${edge.yMod - 3.5} L 83 ${edge.yMod} L 77 ${edge.yMod + 3.5}`}
                          stroke={strokeColor}
                          strokeWidth={sw}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </g>
                    );
                  })}
                </svg>
              </div>
            </>
          )}

          {/* Column 2: Edited Files (Single Canonical Identity for All Touched Files) */}
          <div className="sys-topology-col is-modified">
            <div className="sys-topology-col-head">
              <h4 className="sys-stack-label">
                {modifiedNodes.length === 1 ? 'Edited File' : 'Edited Files'} (
                {modifiedNodes.length})
              </h4>
              {coModifiedEdgesCount > 0 && (
                <span className="sys-pill is-accent">{coModifiedEdgesCount} Linked Edit</span>
              )}
            </div>
            <ul className="dep-node-list">
              {modifiedNodes.map((node) => (
                <li
                  key={node.id}
                  className={`dep-node-card is-active-mod ${nodeTraceClass(node.id)}`}
                  onMouseEnter={() => setHoveredNode(node.id)}
                  onMouseLeave={() => setHoveredNode(null)}
                >
                  <div className="dep-node-top">
                    {node.callId ? (
                      <button
                        type="button"
                        className="sys-edge-node is-btn mono"
                        onClick={() => node.callId && onRef(node.callId)}
                        title={node.path}
                      >
                        <span className="dep-node-base">{basename(node.path)}</span>
                      </button>
                    ) : (
                      <span className="sys-edge-node mono" title={node.path}>
                        <span className="dep-node-base">{basename(node.path)}</span>
                      </span>
                    )}
                    <span className="sys-cluster-delta num">
                      {(node.linesAdded > 0 || node.linesRemoved > 0) && (
                        <>
                          <span className="add">+{node.linesAdded}</span>{' '}
                          <span className="del">-{node.linesRemoved}</span>{' '}
                        </>
                      )}
                      <span
                        className={`dep-node-status ${node.verified ? 'is-ok' : 'is-warn'}`}
                        aria-hidden="true"
                      >
                        {node.verified ? '✓' : '?'}
                      </span>
                    </span>
                  </div>
                  <div className="sys-edge-badges">
                    <span className="where-quiet mono">
                      {node.modName ?? dirname(node.path).replace(/^packages\//, '')}
                    </span>
                    {node.usesEditedPeers.map((peer) => (
                      <span
                        key={`uses-${peer}`}
                        className="where-changed"
                        title={`Imports ${peer}`}
                      >
                        ↳ {basename(peer)}
                      </span>
                    ))}
                    {node.usedByEditedPeers.map((peer) => (
                      <span
                        key={`usedby-${peer}`}
                        className="where-changed"
                        title={`Imported by ${peer}`}
                      >
                        ↑ {basename(peer)}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {hasDownstream && (
            <>
              {/* SVG Gutter 2: Clean Left-to-Right Curves (Edited Files -> Dependents & Tests) */}
              <div className="dep-svg-col" aria-hidden="true">
                <div className="dep-svg-col-spacer" />
                <svg
                  className="dep-svg-gutter"
                  viewBox={`0 0 88 ${svgHeight}`}
                  style={{ height: svgHeight }}
                  fill="none"
                  aria-hidden="true"
                >
                  {rightSvgEdges.map((edge) => {
                    const traced =
                      hoveredNode !== null &&
                      (hoveredNode === edge.blastId || hoveredNode === edge.modId);
                    const dimmed = hoveredNode !== null && !traced;
                    const strokeColor = traced
                      ? 'var(--custom-accent-color, var(--accent))'
                      : edge.isTest
                        ? 'var(--custom-connector-color, var(--border-strong))'
                        : 'var(--warn)';
                    const sw = traced
                      ? String(styleConfig.connectorWidthPx + 0.65)
                      : String(styleConfig.connectorWidthPx);
                    return (
                      <g
                        key={`curve-${edge.key}`}
                        className={`dep-svg-edge ${traced ? 'is-traced' : ''} ${dimmed ? 'is-dimmed' : ''}`}
                      >
                        <circle cx="5" cy={edge.yMod} r="2.4" fill={strokeColor} />
                        <path
                          d={buildConnectorPath(
                            styleConfig.connectorStyle,
                            5,
                            edge.yMod,
                            82,
                            edge.yBlast,
                          )}
                          stroke={strokeColor}
                          strokeWidth={sw}
                        />
                        <path
                          d={`M 77 ${edge.yBlast - 3.5} L 83 ${edge.yBlast} L 77 ${edge.yBlast + 3.5}`}
                          stroke={strokeColor}
                          strokeWidth={sw}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </g>
                    );
                  })}
                </svg>
              </div>

              {/* Column 3: Dynamically Derived Downstream Dependents & Tests */}
              <div className="sys-topology-col is-blast">
                <div className="sys-topology-col-head">
                  <h4 className="sys-stack-label">{downstreamTitle}</h4>
                  {callerBlastCount > 0 && (
                    <span className="sys-pill is-warn">
                      {callerBlastCount} Unedited {callerBlastCount === 1 ? 'Caller' : 'Callers'}
                    </span>
                  )}
                </div>

                <ul className="dep-node-list">
                  {blastNodes.map((node) => (
                    <li
                      key={node.id}
                      className={`dep-node-card ${node.role ? '' : 'is-untouched-neighbor'} ${nodeTraceClass(node.id)}`}
                      onMouseEnter={() => setHoveredNode(node.id)}
                      onMouseLeave={() => setHoveredNode(null)}
                    >
                      <div className="dep-node-top">
                        {node.callId ? (
                          <button
                            type="button"
                            className="sys-edge-node is-btn mono"
                            onClick={() => node.callId && onRef(node.callId)}
                            title={node.path}
                          >
                            <DepNodePath path={node.path} />
                          </button>
                        ) : (
                          <span className="sys-edge-node mono" title={node.path}>
                            <DepNodePath path={node.path} />
                          </span>
                        )}
                        {node.sub && (
                          <span className="dep-node-dir mono" title={node.sub}>
                            {node.sub.replace(/^packages\//, '')}
                          </span>
                        )}
                      </div>
                      <div className="sys-edge-badges">
                        {node.kind === 'ring2' ? (
                          <span className="where-quiet">Dependent Package</span>
                        ) : node.role ? (
                          <span className="rp-derived" title={`Inferred: ${node.role.rule}`}>
                            Test Suite
                          </span>
                        ) : (
                          <span className="sys-neighbor-untouched">Unedited Caller</span>
                        )}
                        {node.edgeKind && EDGE_KIND_WORDS[node.edgeKind] && (
                          <span className="where-quiet">{EDGE_KIND_WORDS[node.edgeKind]}</span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </div>
      )}

      {unmappedRepos.map((repository) => {
        const repoFiles = links.files.filter(
          (f) => f.status === 'repository-not-mapped' && f.repository === repository.root,
        );
        const allowing = allowingRepository === repository.root;
        const repoAllowError = allowingRepository === repository.root ? allowError : undefined;
        return (
          <section
            key={repository.root}
            className={`sys-unmapped-card is-${repository.status}`}
            aria-label={`Repository ${repository.root}`}
          >
            <p className="where-at">
              <bdi className="mono" title={repository.root}>
                {shortHome(repository.root)}
              </bdi>
            </p>
            <p className="where-why">{describeRepositoryStatus(repository)}</p>
            {repository.status === 'not-opted-in' && (
              <div className="where-optin">
                {onAllowRepository && (
                  <div className="operations-actions">
                    <button
                      type="button"
                      className="btn btn-accent"
                      disabled={allowing}
                      onClick={() => onAllowRepository(repository.root)}
                    >
                      {allowing ? 'Allowing…' : 'Allow Repository'}
                    </button>
                  </div>
                )}
                {repoAllowError && (
                  <p className="is-action-error" role="alert">
                    {repoAllowError}
                  </p>
                )}
                <pre className="where-command mono">
                  <code>salidium map allow {shellWord(repository.root)}</code>
                </pre>
              </div>
            )}
            {repository.status === 'map-unavailable' &&
              repository.unavailable === 'busy' &&
              onRetry && (
                <button type="button" className="btn" onClick={onRetry}>
                  Try again
                </button>
              )}
            {repoFiles.length > 0 && (
              <ul className="where-plain">
                {repoFiles.map((f) => (
                  <li key={f.path} className="mono" title={f.path}>
                    <bdi>{f.relativePath ?? f.path}</bdi>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}

      {(['not-in-map', 'outside-repository', 'repository-unknown'] as const).map((status) => {
        const unlinked = links.files.filter((f) => f.status === status);
        if (unlinked.length === 0) return null;
        return (
          <div key={status} className="sys-unlinked-card">
            <p className="where-why">{UNLINKED_FILE_WORDS[status]}</p>
            <ul className="where-plain">
              {unlinked.map((f) => (
                <li key={f.path} className="mono" title={f.path}>
                  <bdi>{f.relativePath ?? shortHome(f.path)}</bdi>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
