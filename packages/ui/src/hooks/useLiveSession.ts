import type { RunState } from '@salidium/core';
import type { SemanticChange, StoredEvent } from '@salidium/protocol';
import { useEffect } from 'react';
import { ApiError } from '../api/client.ts';
import type { LiveError } from '../store/appStore.ts';
import { useAppStore } from '../store/appStore.ts';
import { classifyStreamSequence } from './streamSequence.ts';

function toLiveError(err: unknown): LiveError {
  if (err instanceof ApiError && err.status === 404)
    return { kind: 'not-found', message: 'Session not found' };
  if (err instanceof ApiError && err.status === 0)
    return { kind: 'unreachable', message: err.message };
  return { kind: 'failed', message: err instanceof Error ? err.message : String(err) };
}

/**
 * Keeps one session live: loads the snapshot (checkpointed state + recent history), then follows
 * the event stream from that sequence number, folding events with the shared reducer. Incoming
 * events are coalesced per animation frame so bursts (backfills, parallel tools) render once.
 * Snapshot failures are stored per session (not as a daemon-wide error); bump `attempt` to retry.
 */
export function useLiveSession(sessionId: string | undefined, attempt = 0): void {
  const api = useAppStore((s) => s.api);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry trigger; incrementing it in the caller is what re-runs this effect after a failed load.
  useEffect(() => {
    if (!api || !sessionId) return;
    let cancelled = false;
    let generation = 0;
    let stopStream: (() => void) | undefined;
    let pendingEvents: StoredEvent[] = [];
    let pendingChanges: SemanticChange[] = [];
    let frame: number | undefined;
    const flush = () => {
      frame = undefined;
      const events = pendingEvents;
      const changes = pendingChanges;
      pendingEvents = [];
      pendingChanges = [];
      if (events.length || changes.length)
        useAppStore.getState().applyEvents(sessionId, events, changes);
    };

    const discardPending = () => {
      pendingEvents = [];
      pendingChanges = [];
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
    };

    const loadFresh = async (): Promise<void> => {
      const mine = ++generation;
      stopStream?.();
      stopStream = undefined;
      // No message from the old generation may be folded after the replacement snapshot. This is
      // the failure mode a replay-window refusal is protecting against, so pending RAF work counts
      // as stale state too.
      discardPending();
      try {
        const snap = await api.snapshot(sessionId);
        if (cancelled || mine !== generation) return;
        const store = useAppStore.getState();
        store.initLive(sessionId, snap.state as RunState, snap.changes);
        store.setDaemonError(undefined);
        // The snapshot carries recent history; fetch the full log in the background.
        api.changes(sessionId).then(
          (all) => {
            if (!cancelled && mine === generation && all.length > snap.changes.length)
              useAppStore.getState().applyEvents(sessionId, [], all);
          },
          () => undefined,
        );
        let streamAfter = snap.seq;
        let expectedSeq = snap.seq + 1;
        stopStream = api.stream(
          () => `/api/sessions/${encodeURIComponent(sessionId)}/stream?after=${streamAfter}`,
          (m) => {
            if (cancelled || mine !== generation) return;
            if (m.type === 'event') {
              const event = m.event as StoredEvent;
              // A reconnect can race one already-decoded frame; duplicates are harmless. A
              // forward gap is not: folding it would make the reducer look current while missing
              // evidence, so replace the generation from a new snapshot immediately.
              const sequence = classifyStreamSequence(expectedSeq, event.seq);
              if (sequence === 'duplicate') return;
              if (sequence === 'resnapshot') {
                void loadFresh();
                return;
              }
              expectedSeq += 1;
              streamAfter = event.seq;
              pendingEvents.push(event);
            } else if (m.type === 'changes') pendingChanges.push(...m.changes);
            else return;
            if (frame === undefined) frame = requestAnimationFrame(flush);
          },
          (status) => {
            if (!cancelled && mine === generation)
              useAppStore.getState().setLiveConnection(sessionId, status);
          },
          () => {
            if (!cancelled && mine === generation) void loadFresh();
          },
        );
      } catch (err) {
        if (cancelled || mine !== generation) return;
        if (err instanceof ApiError && err.status === 401) return; // the client already dropped the token
        useAppStore.getState().setLiveError(sessionId, toLiveError(err));
      }
    };
    void loadFresh();
    return () => {
      cancelled = true;
      generation += 1;
      stopStream?.();
      discardPending();
    };
  }, [api, sessionId, attempt]);
}

/** Global session list: initial fetch + summary stream. */
export function useSessionList(): void {
  const api = useAppStore((s) => s.api);
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api.sessions().then(
      (list) => {
        if (cancelled) return;
        const store = useAppStore.getState();
        store.upsertSessions(list);
        store.setDaemonError(undefined);
      },
      (err) => {
        if (cancelled || (err instanceof ApiError && err.status === 401)) return;
        useAppStore.getState().setDaemonError(err instanceof Error ? err.message : String(err));
      },
    );
    const stop = api.stream(
      '/api/stream',
      (m) => {
        if (m.type === 'session') useAppStore.getState().upsertSessions([m.summary]);
        if (m.type === 'sessionRemoved') useAppStore.getState().removeSession(m.id);
      },
      (status) => useAppStore.getState().setListConnection(status),
    );
    return () => {
      cancelled = true;
      stop();
    };
  }, [api]);
}
