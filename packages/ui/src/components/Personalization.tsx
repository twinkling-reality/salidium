import { useEffect, useRef, useState } from 'react';
import { activeExplanationCadence } from '../lib/explanationMode.ts';
import { useAppStore } from '../store/appStore.ts';
import { Icon } from './Icon.tsx';
import { Loading } from './Loading.tsx';

export function PersonalizationSettings({
  sessionId,
  hasCurrentPresentation,
  onDone,
}: {
  sessionId: string;
  hasCurrentPresentation: boolean;
  onDone?: () => void;
}) {
  const settings = useAppStore((state) => state.personalization);
  const loading = useAppStore((state) => state.personalizationLoading);
  const loadError = useAppStore((state) => state.personalizationLoadError);
  const explainer = useAppStore((state) => state.explainer);
  const load = useAppStore((state) => state.loadPersonalization);
  const save = useAppStore((state) => state.savePersonalization);
  const clear = useAppStore((state) => state.deletePersonalization);
  const personalize = useAppStore((state) => state.personalizeSession);
  const [guidance, setGuidance] = useState<string>();
  const guidanceRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<
    | 'idle'
    | 'saving'
    | 'saved'
    | 'generating'
    | 'personalized'
    | 'clearing'
    | 'cleared'
    | 'save-error'
    | 'generation-error'
    | 'clear-error'
  >('idle');

  useEffect(() => load(), [load]);
  useEffect(() => guidanceRef.current?.focus(), []);
  useEffect(() => {
    if (settings && guidance === undefined) setGuidance(settings.profile.guidance);
  }, [guidance, settings]);

  if (!settings || guidance === undefined) {
    if (loadError) {
      return (
        <div className="ex-personalize mu-load-error" role="alert">
          <span>{loadError}</span>
          <button className="btn mu-retry" type="button" onClick={load}>
            <Icon name="reset" />
            Retry
          </button>
        </div>
      );
    }
    return (
      <Loading
        label={loading ? 'Loading personalization settings' : 'Waiting for Salidium'}
        block
      />
    );
  }

  const savedGuidance = settings.profile.guidance;
  const trimmedGuidance = guidance.trim();
  const hasSavedTerms = settings.revision !== 'none' && savedGuidance !== '';
  const hasEnabledProfile = settings.enabled && hasSavedTerms;
  const dirty = trimmedGuidance !== savedGuidance;
  const cadence = activeExplanationCadence(explainer);
  const explainerLoading = explainer === undefined;
  const canPersonalize = Boolean(cadence && cadence !== 'off' && explainer?.activeBackend);
  const busy = status === 'saving' || status === 'generating' || status === 'clearing';
  const needsSave = dirty || !hasEnabledProfile;
  const applied = hasCurrentPresentation && !dirty;
  const saveState = dirty
    ? { icon: 'edit' as const, label: 'Unsaved changes', state: 'dirty' }
    : hasSavedTerms
      ? { icon: 'check' as const, label: 'Saved on this machine', state: 'saved' }
      : { icon: 'close' as const, label: 'Not saved', state: 'empty' };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!trimmedGuidance || busy) return;
    if (needsSave) {
      try {
        setStatus('saving');
        await save({ enabled: true, profile: { guidance: trimmedGuidance } });
      } catch {
        setStatus('save-error');
        return;
      }
    }
    if (canPersonalize) {
      try {
        setStatus('generating');
        await personalize(sessionId);
        setStatus('personalized');
        onDone?.();
      } catch {
        setStatus('generation-error');
      }
    } else {
      setStatus('saved');
    }
  };

  const deleteProfile = async () => {
    setStatus('clearing');
    try {
      await clear();
      setGuidance('');
      setStatus('cleared');
    } catch {
      setStatus('clear-error');
    }
  };

  return (
    <form id="personalization-composer" className="ex-personalize" onSubmit={submit}>
      <label className="mu-guidance-label" htmlFor="personalization-guidance">
        Terms and examples
      </label>
      <span className="sr-only" id="personalization-boundary">
        {canPersonalize
          ? 'Personalizing sends this note and the generated explanation to the selected explanation agent. Evidence and transcripts stay local.'
          : 'Saving keeps this note on this machine.'}
      </span>
      <div className="mu-composer">
        <input
          id="personalization-guidance"
          ref={guidanceRef}
          className="mu-guidance"
          type="text"
          value={guidance}
          onChange={(event) => {
            setGuidance(event.target.value);
            setStatus('idle');
          }}
          aria-describedby="personalization-boundary"
          maxLength={800}
          placeholder="Use kitchen examples…"
        />
        <button
          className="btn btn-accent"
          type="submit"
          disabled={
            !trimmedGuidance || busy || explainerLoading || (canPersonalize ? applied : !needsSave)
          }
          title={
            canPersonalize
              ? hasCurrentPresentation
                ? "Replaces this report's current personalized version"
                : 'Creates one personalized version of this report'
              : 'Saves this note on this machine'
          }
        >
          {status === 'saving' || status === 'generating' || explainerLoading ? (
            <Loading
              label={
                status === 'saving'
                  ? 'Saving'
                  : status === 'generating'
                    ? 'Applying'
                    : 'Loading model settings'
              }
            />
          ) : (
            <>
              <Icon name={applied ? 'check' : canPersonalize ? 'sliders' : 'save'} />
              {canPersonalize ? (applied ? 'Applied' : 'Apply') : 'Save terms'}
            </>
          )}
        </button>
      </div>

      <div className="mu-meta">
        <p className={`mu-save-state is-${saveState.state}`} role="status">
          <Icon name={saveState.icon} />
          {saveState.label}
        </p>
        {hasSavedTerms && (
          <button className="btn mu-clear" type="button" disabled={busy} onClick={deleteProfile}>
            {status === 'clearing' ? (
              <Loading label="Deleting" />
            ) : (
              <>
                <Icon name="trash" />
                Delete saved terms
              </>
            )}
          </button>
        )}
      </div>

      <p className="mu-status" role="status">
        {status === 'save-error'
          ? 'Not saved. Try again.'
          : status === 'generation-error'
            ? 'Saved, but this report was not updated. Try again.'
            : status === 'clear-error'
              ? 'Not cleared. Try again.'
              : ''}
      </p>
    </form>
  );
}
