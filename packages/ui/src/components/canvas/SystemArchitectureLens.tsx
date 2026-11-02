import { composeCanvasSpec, type FileRow, type SessionView } from '@salidium/core';
import type { ExecutionLinks, FileLink } from '@salidium/project-map';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { basename, commonDir, dirname, shortHome, shortPath, timeOfDay } from '../../lib/format.ts';
import { outcomeGlyph } from '../../lib/outcome.ts';
import { entrypointMeta, providerIcon, providerLabel } from '../../lib/providerLabel.ts';
import type { CanvasStyleConfig } from '../../lib/visualPresets.ts';
import { type CanvasDensity, useAppStore } from '../../store/appStore.ts';
import { Icon, type IconName } from '../Icon.tsx';
import { Loading } from '../Loading.tsx';
import { refetchDelay } from '../WhereItSits.tsx';
import { ProjectMapTopologySection } from './ProjectMapTopologySection.tsx';

export interface ModuleCluster {
  name: string;
  files: FileRow[];
  linesAdded: number;
  linesRemoved: number;
  verifiedCount: number;
}

export function groupFilesIntoClusters(files: FileRow[], cwd: string): ModuleCluster[] {
  const root = commonDir(files.map((f) => f.path));
  const map = new Map<string, FileRow[]>();
  for (const file of files) {
    const rel = root ? file.path.slice(root.length) : shortPath(file.path, cwd);
    const dir = dirname(rel).replace(/^\/+|\/+$/g, '');
    const parts = dir.split('/').filter(Boolean);
    const bucket = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0] || 'root';
    const list = map.get(bucket) ?? [];
    list.push(file);
    map.set(bucket, list);
  }
  return [...map.entries()]
    .map(([name, group]) => ({
      name,
      files: [...group].sort(
        (a, b) => b.linesAdded + b.linesRemoved - (a.linesAdded + a.linesRemoved),
      ),
      linesAdded: group.reduce((sum, f) => sum + f.linesAdded, 0),
      linesRemoved: group.reduce((sum, f) => sum + f.linesRemoved, 0),
      verifiedCount: group.filter((f) => f.verifiedAfter).length,
    }))
    .sort((a, b) => b.linesAdded + b.linesRemoved - (a.linesAdded + a.linesRemoved));
}

interface ToolMixItem {
  key: string;
  label: string;
  icon: IconName;
  count: number;
}

function deriveToolMix(view: SessionView): ToolMixItem[] {
  let commands = 0;
  let edits = 0;
  let reads = 0;
  let searches = 0;
  let subagents = 0;
  let web = 0;
  let mcp = 0;
  let plans = 0;

  for (const turn of view.turns) {
    for (const act of turn.activities) {
      switch (act.kind) {
        case 'command':
          commands += 1;
          break;
        case 'fileEdit':
        case 'fileWrite':
          edits += 1;
          break;
        case 'fileRead':
          reads += 1;
          break;
        case 'search':
          searches += 1;
          break;
        case 'subagent':
          subagents += 1;
          break;
        case 'webFetch':
        case 'webSearch':
          web += 1;
          break;
        case 'mcp':
          mcp += 1;
          break;
        case 'plan':
          plans += 1;
          break;
        default:
          break;
      }
    }
  }

  commands = Math.max(commands, view.changes.commands.length);
  const fileEditsTotal = view.changes.files.reduce((sum, f) => sum + f.changeCount, 0);
  edits = Math.max(edits, fileEditsTotal);
  subagents = Math.max(subagents, view.subagents.length);

  const items: ToolMixItem[] = [
    { key: 'terminal', label: 'Terminal', icon: 'terminal', count: commands },
    { key: 'edit', label: 'Edit', icon: 'edit', count: edits },
    { key: 'read', label: 'Read', icon: 'record', count: reads },
    { key: 'search', label: 'Search', icon: 'search', count: searches },
    { key: 'subagent', label: 'Subagent', icon: 'delegate', count: subagents },
    { key: 'web', label: 'Web', icon: 'globe', count: web },
    { key: 'mcp', label: 'MCP', icon: 'mcp', count: mcp },
    { key: 'plan', label: 'Plan', icon: 'plan', count: plans },
  ];
  return items.filter((item) => item.count > 0);
}

function FlowConnectorSvg() {
  return (
    <div className="sys-connector" aria-hidden="true">
      <svg className="sys-connector-svg" viewBox="0 0 28 32" fill="none" aria-hidden="true">
        <circle cx="3" cy="16" r="2.2" fill="currentColor" />
        <path
          d="M 5 16 L 22 16"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeDasharray="2.5 2.5"
        />
        <path
          d="M 19 12 L 25 16 L 19 20"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function FailureCausalChainSection({
  view,
  cwd,
  onRef,
}: {
  view: SessionView;
  cwd: string;
  onRef: (ref: string) => void;
}) {
  const failingRuns = view.verified.runs.filter(
    (r) => r.outcome === 'fail' || r.outcome === 'partial',
  );
  if (failingRuns.length === 0) return null;

  const unverifiedFiles = view.changes.files.filter((f) => !f.verifiedAfter).slice(0, 4);
  const latestFail = failingRuns[failingRuns.length - 1] ?? failingRuns[0];
  if (!latestFail) return null;

  return (
    <section
      className="dil-failure-chain"
      aria-label="Failing check details"
      data-dil-block="failure-chain"
    >
      <div className="dil-failure-head">
        <span className="dil-failure-badge">Failing Check</span>
        <span className="mono where-quiet">
          {failingRuns.length} failing {failingRuns.length === 1 ? 'check' : 'checks'}
        </span>
      </div>
      <div className="sys-grid dil-failure-grid">
        <div className="sys-tier">
          <h4 className="sys-stack-label">1. Edited Before Failure ({unverifiedFiles.length})</h4>
          <div className="sys-stack">
            {unverifiedFiles.map((file) => (
              <button
                key={file.path}
                type="button"
                className="sys-node-btn is-outcome-partial"
                onClick={() => onRef(file.lastCallId)}
                title={shortPath(file.path, cwd)}
              >
                <span className="sys-node-glyph" aria-hidden="true">
                  ~
                </span>
                <span className="sys-node-name mono">{basename(file.path)}</span>
                <span className="sys-node-meta mono num">
                  +{file.linesAdded}/-{file.linesRemoved}
                </span>
              </button>
            ))}
          </div>
        </div>

        <FlowConnectorSvg />

        <div className="sys-tier">
          <h4 className="sys-stack-label">2. Failing Command</h4>
          <div className="sys-stack">
            {failingRuns.slice(0, 3).map((run) => (
              <button
                key={run.id}
                type="button"
                className="sys-node-btn is-outcome-fail"
                onClick={() => onRef(run.callId)}
                title={run.command}
              >
                <span className="sys-node-glyph" aria-hidden="true">
                  {outcomeGlyph(run.outcome)}
                </span>
                <span className="sys-node-name mono">{run.command}</span>
                <span className="sys-node-meta mono">
                  {run.counts?.failed !== undefined ? `${run.counts.failed} failed` : run.outcome}
                </span>
              </button>
            ))}
          </div>
        </div>

        <FlowConnectorSvg />

        <div className="sys-tier">
          <h4 className="sys-stack-label">3. Error Output</h4>
          <div className="dil-failure-excerpt mono">
            {latestFail.failureExcerpt
              ? latestFail.failureExcerpt.slice(0, 220)
              : `${latestFail.label} exited with failure status.`}
          </div>
        </div>
      </div>
    </section>
  );
}

export function SystemArchitectureLens({
  view,
  sessionId,
  provider,
  entrypoint,
  cwd,
  displayedExplanation,
  density = 'files',
  showBlastRadius = true,
  showVerification = true,
  styleConfig,
  executionLinks,
  linksChangedKey,
  onAllowRepository,
  allowingRepository,
  allowError,
  onRef,
}: {
  view: SessionView;
  sessionId: string;
  provider: string;
  entrypoint?: string;
  cwd: string;
  displayedExplanation?: SessionView['explained'];
  density?: CanvasDensity;
  showBlastRadius?: boolean;
  showVerification?: boolean;
  styleConfig: CanvasStyleConfig;
  executionLinks?: ExecutionLinks;
  linksChangedKey?: string;
  onAllowRepository?: (root: string) => void;
  allowingRepository?: string;
  allowError?: string;
  onRef: (ref: string) => void;
}) {
  const api = useAppStore((s) => s.api);
  const [fetchedLinks, setFetchedLinks] = useState<ExecutionLinks | undefined>(undefined);
  const [loadingLinks, setLoadingLinks] = useState(false);
  const [linksError, setLinksError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [refetches, setRefetches] = useState(0);
  const [localAllowingRepo, setLocalAllowingRepo] = useState<string | undefined>(undefined);
  const [localAllowError, setLocalAllowError] = useState<string | undefined>(undefined);

  const lastFetch = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seenKey = useRef(linksChangedKey);

  const hasFiles = view.changes.files.length > 0;
  const shouldFetchLinks = executionLinks === undefined && Boolean(api) && hasFiles;

  useEffect(() => {
    if (!shouldFetchLinks || linksChangedKey === seenKey.current) return;
    seenKey.current = linksChangedKey;
    if (pending.current !== undefined) return;
    pending.current = setTimeout(
      () => {
        pending.current = undefined;
        setRefetches((n) => n + 1);
      },
      refetchDelay(lastFetch.current, Date.now()),
    );
  }, [linksChangedKey, shouldFetchLinks]);

  useEffect(
    () => () => {
      if (pending.current !== undefined) clearTimeout(pending.current);
      pending.current = undefined;
    },
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` and `refetches` trigger refetches of project-map execution links.
  useEffect(() => {
    if (!shouldFetchLinks || !api) return;
    const controller = new AbortController();
    lastFetch.current = Date.now();
    setLoadingLinks((prev) => (fetchedLinks ? prev : true));
    setLinksError(false);
    api
      .sessionLinks(sessionId, controller.signal)
      .then((nextLinks) => {
        setFetchedLinks(nextLinks);
        setLoadingLinks(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoadingLinks(false);
          setLinksError(true);
        }
      });
    return () => controller.abort();
  }, [shouldFetchLinks, api, sessionId, attempt, refetches]);

  const handleAllowRepository = useCallback(
    (root: string) => {
      if (onAllowRepository) {
        onAllowRepository(root);
        return;
      }
      if (!api) return;
      setLocalAllowingRepo(root);
      setLocalAllowError(undefined);
      api
        .allowProjectMapRepository(root)
        .then(() => {
          setLocalAllowingRepo(undefined);
          setAttempt((a) => a + 1);
        })
        .catch((err) => {
          setLocalAllowError(err instanceof Error ? err.message : String(err));
        });
    },
    [onAllowRepository, api],
  );

  const retryLinks = useCallback(() => setAttempt((a) => a + 1), []);
  const links = executionLinks ?? fetchedLinks;
  const effectiveAllowingRepo = allowingRepository ?? localAllowingRepo;
  const effectiveAllowError = allowError ?? localAllowError;

  const fileLinkByPath = useMemo(() => {
    const map = new Map<string, FileLink>();
    if (!links) return map;
    for (const fl of links.files) {
      map.set(fl.path, fl);
      if (fl.relativePath) {
        map.set(fl.relativePath, fl);
        if (fl.repository) {
          map.set(`${fl.repository.replace(/\/+$/, '')}/${fl.relativePath}`, fl);
        }
      }
    }
    return map;
  }, [links]);

  const clusters = useMemo(
    () => groupFilesIntoClusters(view.changes.files, cwd),
    [view.changes.files, cwd],
  );
  const checks = view.verified.summary;
  const openReviews = useMemo(
    () => view.review.groups.filter((g) => g.severity !== 'info'),
    [view.review.groups],
  );
  const toolMix = useMemo(() => deriveToolMix(view), [view]);
  const ep = entrypointMeta(entrypoint);
  const verifiedFilesCount = useMemo(
    () => view.changes.files.filter((f) => f.verifiedAfter).length,
    [view.changes.files],
  );
  const totalFilesCount = view.changes.files.length;
  const verifiedPct =
    totalFilesCount > 0 ? Math.round((verifiedFilesCount / totalFilesCount) * 100) : 100;
  const canvasSpec = useMemo(
    () =>
      composeCanvasSpec(view, {
        links,
        explanation: displayedExplanation,
      }),
    [view, links, displayedExplanation],
  );
  const hasFailureChain = canvasSpec.blocks.some((b) => b.kind === 'failure-chain');
  const hasMappedTopology =
    showBlastRadius &&
    styleConfig.sections.codeMap &&
    Boolean(links?.repositories.some((r) => r.status === 'mapped')) &&
    Boolean(links?.files.some((f) => f.status === 'linked'));
  const showModulesTier = !hasMappedTopology || styleConfig.sections.editedFilesSummary;

  let nextSectionNum = 1;
  const agentIdx = styleConfig.sections.agentAndTools
    ? String(nextSectionNum++).padStart(2, '0')
    : '01';
  const modulesIdx = showModulesTier ? String(nextSectionNum++).padStart(2, '0') : '02';
  const checksIdx = styleConfig.sections.checksAndReview
    ? String(nextSectionNum++).padStart(2, '0')
    : '03';
  const codeMapIdx = String(nextSectionNum++).padStart(2, '0');

  return (
    <section className="ex canvas-diagram" aria-label="Session overview diagram">
      <header className="canvas-diagram-head">
        <div className="canvas-diagram-title-row">
          <h2 className="ex-title">Session Overview</h2>
        </div>
      </header>

      {hasFailureChain && <FailureCausalChainSection view={view} cwd={cwd} onRef={onRef} />}

      {(styleConfig.sections.agentAndTools ||
        showModulesTier ||
        styleConfig.sections.checksAndReview) && (
        <div className={`sys-grid ${!showModulesTier ? 'is-compact-context' : ''}`}>
          {styleConfig.sections.agentAndTools && (
            <div className="sys-tier is-actors">
              <h3 className="sys-tier-title" data-index={agentIdx}>
                Agent &amp; Tools
              </h3>
              <div className="sys-card is-primary">
                <div className="sys-card-top">
                  <span className="sys-badge has-ico">
                    <Icon name={providerIcon(provider)} />
                    Agent
                  </span>
                  {ep && (
                    <span className="sys-surface-badge" title={`Surface: ${ep.label}`}>
                      <Icon name={ep.icon} />
                      <span>{ep.label}</span>
                    </span>
                  )}
                </div>
                <strong className="sys-card-title">{providerLabel(provider)}</strong>
                {view.strip.model && (
                  <span className="sys-card-sub has-ico mono">
                    <Icon name="model" />
                    <span>{view.strip.model}</span>
                  </span>
                )}
                <span className="sys-card-meta">
                  {view.turns.length} {view.turns.length === 1 ? 'turn' : 'turns'} ·{' '}
                  {view.changes.commands.length}{' '}
                  {view.changes.commands.length === 1 ? 'command' : 'commands'}
                </span>
              </div>

              {toolMix.length > 0 && (
                <div className="sys-stack">
                  <span className="sys-stack-label">Tools Used</span>
                  <div className="sys-tool-mix">
                    {toolMix.map((tool) => (
                      <span key={tool.key} className="sys-tool-chip">
                        <Icon name={tool.icon} />
                        <span>{tool.label}</span>
                        <span className="sys-tool-count num">{tool.count}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {view.subagents.length > 0 && (
                <div className="sys-stack">
                  <span className="sys-stack-label">Subagents ({view.subagents.length})</span>
                  {view.subagents.slice(0, 6).map((sub) => (
                    <button
                      key={sub.id}
                      type="button"
                      className="sys-node-btn"
                      onClick={() => onRef(sub.eventId)}
                    >
                      <span className="sys-node-kind">{sub.agentType || 'subagent'}</span>
                      <span className="sys-node-name">{sub.description || sub.id}</span>
                      <span className="sys-node-meta num">{sub.toolCalls} calls</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {showModulesTier && (
            <>
              {styleConfig.sections.agentAndTools && <FlowConnectorSvg />}

              <div className="sys-tier is-modules">
                <h3 className="sys-tier-title" data-index={modulesIdx}>
                  {view.changes.files.length === 1 ? 'Edited File' : 'Edited Files'} (
                  {view.changes.files.length})
                </h3>
                {clusters.length === 0 ? (
                  <div className="sys-card is-muted">
                    <strong className="sys-card-title">Read-only / Command session</strong>
                    <span className="sys-card-meta">
                      No file edits recorded in {shortHome(cwd)}.
                    </span>
                  </div>
                ) : (
                  <div className="sys-clusters">
                    {clusters.slice(0, 6).map((cluster) => {
                      const clusterModule = cluster.files
                        .map((f) => fileLinkByPath.get(f.path)?.modules[0]?.module)
                        .find((m) => m !== undefined);
                      return (
                        <div key={cluster.name} className="sys-cluster">
                          <div className="sys-cluster-head">
                            <span className="sys-cluster-name mono">
                              {cluster.name}
                              {clusterModule && (
                                <span
                                  className="sys-cluster-pkg"
                                  title={`Module manifest: ${clusterModule.manifest}`}
                                >
                                  {clusterModule.name ?? clusterModule.manifest}
                                </span>
                              )}
                            </span>
                            <span className="sys-cluster-delta num">
                              <span className="add">+{cluster.linesAdded}</span>{' '}
                              <span className="del">-{cluster.linesRemoved}</span>
                            </span>
                          </div>
                          {density === 'modules' ? (
                            <div className="sys-cluster-summary">
                              <span className="mono">
                                {cluster.files.length}{' '}
                                {cluster.files.length === 1 ? 'file' : 'files'}
                              </span>
                              <span>·</span>
                              <span
                                className={
                                  cluster.verifiedCount === cluster.files.length
                                    ? 'sys-ver-ok'
                                    : 'sys-ver-warn'
                                }
                              >
                                {cluster.verifiedCount}/{cluster.files.length} verified
                              </span>
                            </div>
                          ) : (
                            <ul className="sys-cluster-files">
                              {cluster.files.slice(0, 5).map((file) => {
                                const fl = fileLinkByPath.get(file.path);
                                return (
                                  <li key={file.path}>
                                    <button
                                      type="button"
                                      className={`sys-file-btn ${file.verifiedAfter ? 'is-verified' : 'is-unverified'}`}
                                      onClick={() => onRef(file.lastCallId)}
                                      title={`${file.path} (+${file.linesAdded}/-${file.linesRemoved})`}
                                    >
                                      <span className="sys-file-name mono">
                                        {basename(file.path)}
                                      </span>
                                      {fl?.role && (
                                        <span
                                          className="sys-file-role"
                                          title={`Inferred: ${fl.role.rule}`}
                                        >
                                          test
                                        </span>
                                      )}
                                      <span className="sys-file-status" aria-hidden="true">
                                        {file.verifiedAfter ? '✓' : '?'}
                                      </span>
                                    </button>
                                  </li>
                                );
                              })}
                              {cluster.files.length > 5 && (
                                <li className="sys-cluster-more">
                                  +{cluster.files.length - 5} more in {cluster.name}
                                </li>
                              )}
                            </ul>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}

          {styleConfig.sections.checksAndReview && (
            <>
              {(styleConfig.sections.agentAndTools || showModulesTier) && <FlowConnectorSvg />}

              <div className="sys-tier is-gates">
                <h3 className="sys-tier-title" data-index={checksIdx}>
                  Checks &amp; Review
                </h3>
                {styleConfig.sections.coverageMeter && totalFilesCount > 0 && (
                  <div className="sys-cov-card">
                    <div className="sys-cov-head">
                      <span className="sys-stack-label">Coverage</span>
                      <span className="mono num sys-cov-pct">
                        {verifiedFilesCount}/{totalFilesCount} · {verifiedPct}%
                      </span>
                    </div>
                    <div className="ver-meter-bar" aria-hidden="true">
                      <span className="ver-meter-fill" style={{ width: `${verifiedPct}%` }} />
                    </div>
                  </div>
                )}

                {checks.length === 0 ? (
                  <div className="sys-card is-warn">
                    <span className="sys-badge">Unverified</span>
                    <strong className="sys-card-title">No checks observed</strong>
                    <span className="sys-card-meta">
                      {view.changes.files.length > 0
                        ? `${view.changes.files.length} modified ${view.changes.files.length === 1 ? 'file has' : 'files have'} no recorded test or build check.`
                        : 'No test, build, or lint runner was observed.'}
                    </span>
                  </div>
                ) : (
                  <div className="sys-stack">
                    {checks.map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        className={`sys-node-btn is-outcome-${v.outcome}`}
                        onClick={() => onRef(v.callId)}
                      >
                        <span className="sys-node-glyph" aria-hidden="true">
                          {outcomeGlyph(v.outcome)}
                        </span>
                        <span className="sys-node-name">{v.method}</span>
                        <span className="sys-node-meta mono">
                          {v.counts?.total !== undefined
                            ? `${v.counts.passed ?? 0}/${v.counts.total}`
                            : v.outcome}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                {view.changes.commits.length > 0 && (
                  <div className="sys-stack">
                    <span className="sys-stack-label">Commits ({view.changes.commits.length})</span>
                    {view.changes.commits.slice(0, 4).map((commit) => (
                      <button
                        key={commit.sha}
                        type="button"
                        className="sys-node-btn is-commit"
                        onClick={() => commit.callId && onRef(commit.callId)}
                      >
                        <span className="sys-node-kind">commit</span>
                        <span className="sys-node-name mono">{commit.sha.slice(0, 7)}</span>
                        <span className="sys-node-meta mono">{timeOfDay(commit.at)}</span>
                      </button>
                    ))}
                  </div>
                )}

                {showVerification && openReviews.length > 0 && (
                  <div className="sys-stack">
                    <span className="sys-stack-label">Review ({openReviews.length})</span>
                    {openReviews.slice(0, 3).map((group) => (
                      <button
                        key={group.rule}
                        type="button"
                        className="sys-node-btn is-review"
                        onClick={() => group.items[0]?.refs[0] && onRef(group.items[0].refs[0])}
                      >
                        <span className="sys-node-kind">{group.severity}</span>
                        <span className="sys-node-name">{group.label}</span>
                        <span className="sys-node-meta num">{group.occurrences}x</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {showBlastRadius && styleConfig.sections.codeMap && loadingLinks && !links && (
        <section className="sys-topology is-loading" aria-label="Dependency edges and blast radius">
          <Loading label="Placing changed files in project map" size="sm" />
        </section>
      )}

      {showBlastRadius && styleConfig.sections.codeMap && linksError && !links && (
        <section className="sys-topology is-error" aria-label="Dependency edges and blast radius">
          <p className="muted">
            Salidium could not read the project map for this session just now.
          </p>
          <button type="button" className="btn" onClick={retryLinks}>
            Try again
          </button>
        </section>
      )}

      {showBlastRadius &&
        styleConfig.sections.codeMap &&
        links &&
        (links.files.length > 0 || links.repositories.length > 0) && (
          <ProjectMapTopologySection
            links={links}
            files={view.changes.files}
            cwd={cwd}
            styleConfig={styleConfig}
            sectionIndex={codeMapIdx}
            onRef={onRef}
            onRetry={retryLinks}
            onAllowRepository={handleAllowRepository}
            allowingRepository={effectiveAllowingRepo}
            allowError={effectiveAllowError}
          />
        )}

      <footer className="ex-foot">
        <div className="ex-attribution">
          <p className="ex-mark">Observed Session Telemetry · Deterministic</p>
        </div>
      </footer>
    </section>
  );
}
