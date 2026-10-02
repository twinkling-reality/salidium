import type { ExecutionLinks } from '@salidium/project-map';
import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '../store/appStore.ts';
import { Loading } from './Loading.tsx';
import { Panel } from './Panel.tsx';
import { WhereItSits } from './WhereItSits.tsx';

/**
 * Where this session's changed files sit in the codebase: each file placed in its module, with
 * every file it imports and every file that imports it, at the commit Salidium saw the session at.
 *
 * Everything here is read from the committed tree, so it is observed, apart from the test role,
 * which a naming rule infers and which says so. There is no component, responsibility or data
 * flow on this panel, because the tree states none of them, and nothing is matched by name: a
 * file that the map's commit does not track is listed as such rather than placed beside its
 * look-alikes.
 *
 * Ring 1 is shown whole. The validation record measured a median of four direct neighbours and a
 * 90th percentile of sixteen, small enough to read without a control in the way. Ring 2, the
 * modules that depend on the changed ones, is one press further out.
 */
export function WhereItSitsPanel({
  sessionId,
  changedKey,
}: {
  sessionId: string;
  /** Changes when the files, their locations or the turn-end anchor do: the moments to refetch. */
  changedKey: string;
}) {
  const api = useAppStore((s) => s.api);
  const open = useAppStore((s) => s.panel) === 'where';
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; links: ExecutionLinks }
  >({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [widened, setWidened] = useState(false);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  // Fetched when opened, and again when the session has moved on while it stays open: a map is
  // built on request, so nothing is read for a panel nobody has asked to see.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` and `changedKey` are refetch triggers.
  useEffect(() => {
    if (!open || !api) return;
    const controller = new AbortController();
    setState((current) => (current.kind === 'ready' ? current : { kind: 'loading' }));
    api
      .sessionLinks(sessionId, controller.signal)
      .then((links) => setState({ kind: 'ready', links }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ kind: 'error' });
      });
    return () => controller.abort();
  }, [open, api, sessionId, attempt, changedKey]);

  return (
    <Panel id="where" title="Where it sits">
      {state.kind === 'loading' && <Loading label="Placing the changed files" size="md" block />}
      {state.kind === 'error' && (
        <div className="where-empty">
          <p className="rp-none">Salidium could not place these files just now.</p>
          <button type="button" className="btn" onClick={retry}>
            Try again
          </button>
        </div>
      )}
      {state.kind === 'ready' && (
        <WhereItSits
          links={state.links}
          widened={widened}
          onWiden={() => setWidened((w) => !w)}
          onRetry={retry}
        />
      )}
    </Panel>
  );
}
