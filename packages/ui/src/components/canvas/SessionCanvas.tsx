import type { SessionView } from '@salidium/core';
import type { ExecutionLinks } from '@salidium/project-map';
import { useMemo, useState } from 'react';
import { canvasStyleToInlineVars } from '../../lib/visualPresets.ts';
import { type CanvasLens, type CanvasStyle, useAppStore } from '../../store/appStore.ts';
import { Icon, type IconName } from '../Icon.tsx';
import { CanvasDesignInspector } from './CanvasDesignInspector.tsx';
import { ExecutionSequenceLens } from './ExecutionSequenceLens.tsx';
import { Explained, ExplanationPending, ObservedBlueprintFallback } from './NarrativeLens.tsx';
import { SystemArchitectureLens } from './SystemArchitectureLens.tsx';
import { VerificationMatrixLens } from './VerificationMatrixLens.tsx';

export { ExplanationPending } from './NarrativeLens.tsx';

export interface SessionCanvasProps {
  view: SessionView;
  sessionId: string;
  provider: string;
  entrypoint?: string;
  cwd: string;
  displayedExplanation: SessionView['explained'];
  showingPersonalized: boolean;
  analogies?: { why: string | null; how: string | null };
  hasAlternate: boolean;
  onToggleVersion?: () => void;
  personalizerOpen: boolean;
  onClosePersonalizer: () => void;
  personalizationNote?: string;
  hasCurrentPresentation: boolean;
  explanationStatus: 'generating' | 'generated' | 'disabled' | 'unavailable' | 'failed' | undefined;
  explanationCadence: 'off' | 'session' | 'turn' | undefined;
  lens?: CanvasLens;
  style?: CanvasStyle;
  executionLinks?: ExecutionLinks;
  linksChangedKey?: string;
  onAllowRepository?: (root: string) => void;
  allowingRepository?: string;
  allowError?: string;
  onRef: (ref: string) => void;
}

export function SessionCanvas(props: SessionCanvasProps) {
  const {
    view,
    sessionId,
    provider,
    cwd,
    displayedExplanation,
    showingPersonalized,
    analogies,
    hasAlternate,
    onToggleVersion,
    personalizerOpen,
    onClosePersonalizer,
    personalizationNote,
    hasCurrentPresentation,
    explanationStatus,
    explanationCadence,
    onRef,
  } = props;

  const storeCanvasLens = useAppStore((s) => s.canvasLens);
  const setCanvasLens = useAppStore((s) => s.setCanvasLens);
  const storeCanvasStyle = useAppStore((s) => s.canvasStyle);
  const canvasDensity = useAppStore((s) => s.canvasDensity);
  const setCanvasDensity = useAppStore((s) => s.setCanvasDensity);
  const canvasBlastRadius = useAppStore((s) => s.canvasBlastRadius);
  const toggleCanvasBlastRadius = useAppStore((s) => s.toggleCanvasBlastRadius);
  const canvasVerification = useAppStore((s) => s.canvasVerification);
  const toggleCanvasVerification = useAppStore((s) => s.toggleCanvasVerification);
  const storeStyleConfig = useAppStore((s) => s.canvasStyleConfig);
  const updateCanvasStyleConfig = useAppStore((s) => s.updateCanvasStyleConfig);
  const resetCanvasStyleConfig = useAppStore((s) => s.resetCanvasStyleConfig);

  const liveStyleConfig = useAppStore.getState().canvasStyleConfig;
  const styleConfig = liveStyleConfig !== storeStyleConfig ? liveStyleConfig : storeStyleConfig;

  const [inspectorOpen, setInspectorOpen] = useState(false);

  const canvasLens = props.lens ?? storeCanvasLens;
  const canvasStyle = props.style ?? storeCanvasStyle;

  const effectiveLens: Exclude<CanvasLens, 'auto'> =
    canvasLens === 'auto' ? (displayedExplanation ? 'narrative' : 'system') : canvasLens;

  const activePrimaryTab: 'system' | 'sequence' | 'narrative' =
    effectiveLens === 'sequence'
      ? 'sequence'
      : effectiveLens === 'narrative'
        ? 'narrative'
        : 'system';

  const currentDetailLevel: 'summary' | 'standard' | 'full' =
    canvasDensity === 'modules' && !canvasBlastRadius
      ? 'summary'
      : canvasVerification && canvasDensity === 'files' && canvasBlastRadius
        ? 'full'
        : 'standard';

  const handleSelectDetailLevel = (level: 'summary' | 'standard' | 'full') => {
    if (level === 'summary') {
      setCanvasDensity('modules');
      if (canvasBlastRadius) toggleCanvasBlastRadius();
      if (canvasVerification) toggleCanvasVerification();
    } else if (level === 'standard') {
      setCanvasDensity('files');
      if (!canvasBlastRadius) toggleCanvasBlastRadius();
      if (canvasVerification) toggleCanvasVerification();
    } else {
      setCanvasDensity('files');
      if (!canvasBlastRadius) toggleCanvasBlastRadius();
      if (!canvasVerification) toggleCanvasVerification();
    }
  };

  const inlineStyle = useMemo(
    () => canvasStyleToInlineVars(styleConfig) as React.CSSProperties,
    [styleConfig],
  );

  return (
    <div
      className="canvas-shell"
      data-canvas-style={canvasStyle}
      data-canvas-lens={effectiveLens}
      data-canvas-density={canvasDensity}
      data-section-marker={styleConfig.sectionMarker}
      data-connector-style={styleConfig.connectorStyle}
      style={inlineStyle}
    >
      <section className="canvas-toolbar" aria-label="Diagram view controls">
        <fieldset className="canvas-switch" aria-label="Diagram view">
          <legend className="canvas-switch-label">View</legend>
          {(
            [
              {
                key: 'system' as const,
                label: 'Overview',
                icon: 'where' as IconName,
                badge: String(view.changes.files.length),
                title:
                  'Overview of the agent, edited files, checks, and connected files in the repository',
              },
              {
                key: 'sequence' as const,
                label: 'Steps',
                icon: 'commit' as IconName,
                badge: String(view.turns.length),
                title: 'Step-by-step progress across each turn (Read, Edited, Checked)',
              },
              {
                key: 'narrative' as const,
                label: 'Why & How',
                icon: 'plan' as IconName,
                badge: displayedExplanation ? 'AI' : 'Summary',
                title: 'Why the change was made and how it works',
              },
            ] as const
          ).map((item) => {
            const active = activePrimaryTab === item.key;
            return (
              <button
                key={item.key}
                type="button"
                className={`canvas-pill has-meta ${active ? 'is-on' : ''}`}
                aria-pressed={active}
                onClick={() => setCanvasLens(item.key)}
                title={item.title}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
                <span className="canvas-pill-badge mono">{item.badge}</span>
              </button>
            );
          })}
        </fieldset>

        <div className="canvas-controls-end">
          {activePrimaryTab === 'system' && (
            <fieldset className="canvas-switch" aria-label="Diagram detail level">
              <legend className="canvas-switch-label">Detail</legend>
              {(
                [
                  ['summary', 'Summary', 'High-level folder summary only'],
                  ['standard', 'Standard', 'Edited files and connected files'],
                  ['full', 'Full', 'All files, connected packages, and coverage'],
                ] as const
              ).map(([key, label, title]) => {
                const active = currentDetailLevel === key;
                return (
                  <button
                    key={key}
                    type="button"
                    className={`canvas-pill ${active ? 'is-on' : ''}`}
                    aria-pressed={active}
                    onClick={() => handleSelectDetailLevel(key)}
                    title={title}
                  >
                    {label}
                  </button>
                );
              })}
            </fieldset>
          )}

          <div className="canvas-switch">
            <button
              type="button"
              className={`canvas-pill ${inspectorOpen ? 'is-on' : ''}`}
              aria-expanded={inspectorOpen}
              onClick={() => setInspectorOpen((v) => !v)}
              title="Open visual & layout inspector to customize colors, spacing, radius, blur, connectors, and visible sections"
            >
              <span>Customize</span>
            </button>
          </div>
        </div>
      </section>

      {inspectorOpen && (
        <CanvasDesignInspector
          config={styleConfig}
          onChange={updateCanvasStyleConfig}
          onReset={resetCanvasStyleConfig}
          onClose={() => setInspectorOpen(false)}
        />
      )}

      {effectiveLens === 'narrative' &&
        (displayedExplanation ? (
          <Explained
            ex={displayedExplanation}
            sessionId={sessionId}
            personalized={showingPersonalized}
            analogies={analogies}
            hasAlternate={hasAlternate}
            onToggleVersion={onToggleVersion}
            personalizerOpen={personalizerOpen}
            onClosePersonalizer={onClosePersonalizer}
            personalizationNote={personalizationNote}
            hasCurrentPresentation={hasCurrentPresentation}
          />
        ) : (
          <>
            <ExplanationPending
              turns={view.turns.length}
              status={explanationStatus}
              cadence={explanationCadence}
            />
            {view.turns.length > 0 && <ObservedBlueprintFallback view={view} cwd={cwd} />}
          </>
        ))}

      {effectiveLens === 'system' && (
        <SystemArchitectureLens
          view={view}
          sessionId={sessionId}
          provider={provider}
          entrypoint={props.entrypoint}
          cwd={cwd}
          displayedExplanation={displayedExplanation}
          density={canvasDensity}
          showBlastRadius={canvasBlastRadius}
          showVerification={canvasVerification}
          styleConfig={styleConfig}
          executionLinks={props.executionLinks}
          linksChangedKey={props.linksChangedKey}
          onAllowRepository={props.onAllowRepository}
          allowingRepository={props.allowingRepository}
          allowError={props.allowError}
          onRef={onRef}
        />
      )}

      {effectiveLens === 'sequence' && <ExecutionSequenceLens view={view} onRef={onRef} />}

      {effectiveLens === 'verification' && (
        <VerificationMatrixLens view={view} cwd={cwd} onRef={onRef} />
      )}
    </div>
  );
}
