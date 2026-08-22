import type {
  ExplainerBackend,
  ExplainerCadence,
  ExplainerRoute,
  ExplainerUsage,
  ProviderId,
} from '@salidium/protocol';
import { useEffect, useRef, useState } from 'react';
import { isAutomaticModel, modelName } from '../lib/modelName.ts';
import { useAppStore } from '../store/appStore.ts';

const STOPS: Array<{ value: ExplainerCadence; name: string }> = [
  { value: 'off', name: 'Off' },
  { value: 'session', name: 'When done' },
  { value: 'turn', name: 'Each reply' },
];

const BACKENDS: Array<{ value: ExplainerBackend; name: string }> = [
  { value: 'auto', name: 'Same as coding' },
  { value: 'claude', name: 'Claude' },
  { value: 'codex', name: 'Codex' },
];

const CODEX_MODELS = [
  { model: 'gpt-5.6-sol', detail: 'Highest capability' },
  { model: 'gpt-5.6-terra', detail: 'Balanced' },
  { model: 'gpt-5.6-luna', detail: 'Lightweight' },
] as const;

interface ModelChoice {
  value: string | null;
  name: string;
  detail: string;
}

function backendName(backend: ExplainerRoute['backend']): string {
  if (backend === 'claude') return 'Claude Code';
  if (backend === 'codex') return 'Codex';
  return 'Unavailable';
}

function ModelRow({
  label,
  model,
  detail,
  exact = true,
}: {
  label: string;
  model: string | null | undefined;
  detail?: string;
  exact?: boolean;
}) {
  return (
    <div className="mu-model-row">
      <dt>{label}</dt>
      <dd>
        <strong className={exact ? 'mono' : undefined}>{model ?? 'Unavailable'}</strong>
        {detail && <span>{detail}</span>}
      </dd>
    </div>
  );
}

function visibleModel(model: string | null | undefined): { name: string; automatic: boolean } {
  return { name: modelName(model), automatic: isAutomaticModel(model) };
}

function ChoiceGroup<T extends string>({
  legend,
  value,
  options,
  disabled,
  onChange,
}: {
  legend: string;
  value: T;
  options: Array<{ value: T; name: string }>;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="mu-choice" data-choice={legend}>
      <legend>{legend}</legend>
      <div className="mu-choice-set">
        {options.map((option) => (
          <button
            type="button"
            className={option.value === value ? 'is-on' : undefined}
            aria-pressed={option.value === value}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            key={option.value}
          >
            {option.name}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function UsageLedger({
  label,
  scope,
  usage,
}: {
  label: string;
  scope?: string;
  usage?: ExplainerUsage;
}) {
  return (
    <div className="mu-usage-ledger">
      <div className="mu-usage-head">
        <span>
          {label}
          {scope && <small>{scope}</small>}
        </span>
        <strong>{usage ? `${usage.messages.toLocaleString()} responses` : 'No token data'}</strong>
      </div>
      {usage && (
        <dl className="mu-usage-grid">
          <div>
            <dt>Input</dt>
            <dd>{usage.inputTokens.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Output</dt>
            <dd>{usage.outputTokens.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Cache reused</dt>
            <dd>{usage.cacheReadTokens.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Cache stored</dt>
            <dd>{usage.cacheWriteTokens.toLocaleString()}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

/** One compact ledger for the models, controls and token usage that can consume provider quota. */
export function ExplanationSettings({
  provider,
  workModel,
  sessionUsage,
  generatedModel,
}: {
  provider?: ProviderId;
  workModel?: string;
  sessionUsage?: ExplainerUsage;
  generatedModel?: string;
}) {
  const api = useAppStore((state) => state.api);
  const explainer = useAppStore((state) => state.explainer);
  const loadExplainer = useAppStore((state) => state.loadExplainer);
  const setExplainer = useAppStore((state) => state.setExplainerSettings);
  const [modelDraft, setModelDraft] = useState('');
  const [showModelChoices, setShowModelChoices] = useState(false);
  const [showCustomModel, setShowCustomModel] = useState(false);
  const modelFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (api) loadExplainer();
  }, [api, loadExplainer]);
  useEffect(() => setModelDraft(explainer?.model ?? ''), [explainer?.model]);
  useEffect(() => {
    if (showCustomModel) modelFieldRef.current?.focus();
  }, [showCustomModel]);

  if (!explainer) {
    return (
      <p className="mu-loading" role="status">
        Loading model settings…
      </p>
    );
  }

  const route =
    provider === 'codex'
      ? explainer.routes.codex
      : provider === 'claude-code'
        ? explainer.routes.claudeCode
        : undefined;
  const modelChanged = modelDraft.trim() !== (explainer.model ?? '');
  const currentExplanationModel = generatedModel ?? route?.model;
  const shownExplanationModel = visibleModel(currentExplanationModel);
  const shownNextModel = visibleModel(route?.model);
  const nextModelChanged = Boolean(
    generatedModel && route?.model && generatedModel !== route.model,
  );
  const providerBackend =
    provider === 'codex' ? 'codex' : provider === 'claude-code' ? 'claude' : null;
  const activeBackend = route?.backend ?? (explainer.backend === 'auto' ? null : explainer.backend);
  const activeRoute =
    route ??
    (activeBackend === 'claude'
      ? explainer.routes.claudeCode
      : activeBackend === 'codex'
        ? explainer.routes.codex
        : undefined);
  const modelChoices: ModelChoice[] = [];
  const exactModels = new Set<string>();
  const addModel = (choice: ModelChoice) => {
    if (choice.value && exactModels.has(choice.value)) return;
    if (choice.value) exactModels.add(choice.value);
    modelChoices.push(choice);
  };

  if (activeBackend === 'claude' && !explainer.model && activeRoute?.model) {
    addModel({ value: null, name: activeRoute.model, detail: 'Salidium default' });
  } else {
    addModel({
      value: null,
      name: 'Automatic',
      detail: activeBackend ? `${backendName(activeBackend)} chooses` : 'Uses the coding agent',
    });
  }
  if (workModel && providerBackend === activeBackend) {
    addModel({ value: workModel, name: workModel, detail: 'Current coding model' });
  }
  if (activeBackend === 'codex') {
    for (const choice of CODEX_MODELS) {
      addModel({ value: choice.model, name: choice.model, detail: choice.detail });
    }
  }
  if (explainer.model) {
    addModel({ value: explainer.model, name: explainer.model, detail: 'Current selection' });
  }

  return (
    <div className="mu">
      <section className="mu-section" aria-labelledby="mu-models">
        <h3 className="mu-title" id="mu-models">
          Models
        </h3>
        <dl className="mu-models">
          {provider ? (
            <>
              <ModelRow label="Coding" model={workModel} />
              <ModelRow
                label="Explanation"
                model={shownExplanationModel.name}
                exact={!shownExplanationModel.automatic}
                detail={
                  shownExplanationModel.automatic
                    ? `${backendName(route?.backend ?? null)} chooses the model`
                    : undefined
                }
              />
              {nextModelChanged && (
                <ModelRow
                  label="Next"
                  model={shownNextModel.name}
                  exact={!shownNextModel.automatic}
                />
              )}
            </>
          ) : (
            <>
              <ModelRow label="Claude" model={explainer.routes.claudeCode.model} />
              <ModelRow
                label="Codex"
                model={visibleModel(explainer.routes.codex.model).name}
                exact={false}
              />
            </>
          )}
        </dl>
      </section>

      <section className="mu-section" aria-labelledby="mu-controls">
        <h3 className="mu-title" id="mu-controls">
          Explanation
        </h3>

        {explainer.envOff && <p className="explain-warning">Disabled by the daemon environment.</p>}
        {!explainer.envOff &&
          explainer.cadence !== 'off' &&
          !explainer.routes.claudeCode.backend &&
          !explainer.routes.codex.backend && (
            <p className="explain-warning">
              {explainer.backendLocked
                ? 'The locked helper is unavailable.'
                : 'No selected helper is installed.'}
            </p>
          )}

        <div className="mu-control-stack">
          <ChoiceGroup
            legend="Agent"
            value={explainer.backend}
            options={BACKENDS}
            disabled={explainer.backendLocked}
            onChange={(backend) => {
              if (backend === explainer.backend) return;
              setModelDraft('');
              setShowCustomModel(false);
              setExplainer({ backend, model: null });
            }}
          />
          <ChoiceGroup
            legend="Create"
            value={explainer.cadence}
            options={STOPS}
            onChange={(cadence) => setExplainer({ cadence })}
          />
        </div>

        {showModelChoices ? (
          <div className="mu-model-picker">
            <div className="mu-model-picker-head">
              <span>Model</span>
              <button
                type="button"
                onClick={() => {
                  setShowCustomModel(false);
                  setShowModelChoices(false);
                }}
              >
                Done
              </button>
            </div>
            <ul className="mu-model-options" aria-label="Explanation model choices">
              {modelChoices.map((choice) => (
                <li key={choice.value ?? 'automatic'}>
                  <button
                    type="button"
                    className="mu-model-option"
                    aria-current={choice.value === (explainer.model ?? null) ? 'true' : undefined}
                    disabled={explainer.modelLocked}
                    onClick={() => {
                      setModelDraft(choice.value ?? '');
                      setExplainer({ model: choice.value });
                      setShowCustomModel(false);
                    }}
                  >
                    <span className="mono">{choice.name}</span>
                    <small>{choice.detail}</small>
                  </button>
                </li>
              ))}
              <li>
                <button
                  type="button"
                  className="mu-model-option"
                  aria-expanded={showCustomModel}
                  disabled={explainer.modelLocked}
                  onClick={() => {
                    setModelDraft(explainer.model ?? '');
                    setShowCustomModel(true);
                  }}
                >
                  <span>Other model…</span>
                  <small>Enter a model name</small>
                </button>
              </li>
            </ul>

            {showCustomModel && (
              <form
                className="mu-model-control"
                onSubmit={(event) => {
                  event.preventDefault();
                  const model = modelDraft.trim();
                  if (!model) return;
                  setExplainer({ model });
                  setShowCustomModel(false);
                }}
              >
                <label htmlFor="explainer-model">Model name</label>
                <div className="mu-model-input">
                  <input
                    ref={modelFieldRef}
                    id="explainer-model"
                    className="field mono"
                    value={modelDraft}
                    onChange={(event) => setModelDraft(event.target.value)}
                    placeholder={activeBackend === 'claude' ? 'claude-…' : 'gpt-…'}
                    maxLength={120}
                    disabled={explainer.modelLocked}
                  />
                  <button
                    className="btn btn-accent"
                    type="submit"
                    disabled={explainer.modelLocked || !modelChanged || !modelDraft.trim()}
                  >
                    Use
                  </button>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      setModelDraft(explainer.model ?? '');
                      setShowCustomModel(false);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
            {(explainer.backendLocked || explainer.modelLocked) && (
              <span className="explain-lock">Locked by the daemon environment.</span>
            )}
          </div>
        ) : (
          <button
            type="button"
            className="mu-exact-trigger"
            aria-expanded="false"
            onClick={() => setShowModelChoices(true)}
          >
            {explainer.model ? 'Change model…' : 'Choose a model…'}
          </button>
        )}
      </section>

      <section className="mu-section" aria-labelledby="mu-usage">
        <h3 className="mu-title" id="mu-usage">
          Usage
        </h3>
        <div className="mu-usage-list">
          {provider && <UsageLedger label="Session" usage={sessionUsage} />}
          <UsageLedger label="Explanations" scope="all runs" usage={explainer.usage} />
        </div>
      </section>
    </div>
  );
}
