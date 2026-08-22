import { applyEvent, type RunState } from '@salidium/core';
import type {
  ExplainerSettings,
  ExplainerSettingsRequest,
  Facet,
  SemanticChange,
  SessionList,
  SessionSummary,
  StoredEvent,
} from '@salidium/protocol';
import { create } from 'zustand';
import { ApiClient, clearToken } from '../api/client.ts';

/** Every kind of change the log records, in the order the rail and the table list them. */
export const ALL_FACETS: Facet[] = ['status', 'what', 'why', 'how', 'verified', 'left', 'review'];

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Why a session's snapshot could not be loaded; rendered in place of the session. */
export interface LiveError {
  kind: 'not-found' | 'unreachable' | 'failed';
  message: string;
}

export interface LiveSession {
  state: RunState;
  /** Bumped whenever `state` was mutated by the reducer; components key memoization on it. */
  revision: number;
  changes: SemanticChange[];
  connection: ConnectionStatus;
  error?: string;
  /** History scrubbing: state as of a past moment (undefined = live). */
  scrub?: { ts: string; seq: number; state: RunState; loading: boolean };
  /** Sequence number when the user last looked at this session (for "since you looked"). */
  lastSeenSeq: number;
}

/**
 * What the daemon answered for a query: which sessions matched, how many matched, and how many
 * were searched.
 *
 * Kept apart from `sessions` because they are different things. `sessions` is everything this
 * client has been told about, which the summary stream adds to continuously; this is one answer to
 * one question, and a session that changed while you were typing may not belong in a list it does
 * not match. It carries the query it answers so a result cannot be shown against newer typing.
 */
export interface SessionSearch {
  /** Trimmed, as it was sent. */
  query: string;
  /** Matched ids in the daemon's order, or undefined for the default view, which is not a search. */
  ids: string[] | undefined;
  /** How many user sessions matched over the whole store. `ids` is the newest page of them. */
  matched: number;
  /**
   * How many user sessions the store holds. Independent of the query — it is what was searched —
   * so it stays true while newer typing is still in flight.
   */
  total: number;
}

/**
 * One control, concrete ends, and semantic depth rather than verbosity:
 * 0 = Summary (the explanation), 1 = Detail (what the evidence shows), 2 = Source (the evidence).
 */
export type Detail = 0 | 1 | 2;

const DETAIL_KEY = 'salidium.detail';
const SIDEBAR_KEY = 'salidium.sidebar';
const THEME_KEY = 'salidium.theme';
const STATS_KEY = 'salidium.stats';
const REWIND_KEY = 'salidium.rewind';
const SIDE_FOLDS_KEY = 'salidium.sideFolds';

/** The one group whose name the store has to know, because it is the one folded by default. */
export const NOTHING_RECORDED = 'Nothing recorded';

/**
 * Which group heads in the session list are folded away.
 *
 * Stored as a list of the group's own name rather than a flag per group, so a group added later
 * starts open without a migration, and "Nothing recorded" — the one group that was always folded
 * by default — keeps that default by being the seed value.
 */
function storedFolds(): string[] {
  const raw = localStorage.getItem(SIDE_FOLDS_KEY);
  if (raw === null) return [NOTHING_RECORDED];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Where the change log is shown. The rail is for glancing while you read the page; the table is
 * for actually working through a long one, which a 320 px column is a poor place to do.
 */
export type HistoryMode = 'off' | 'rail' | 'table';

/** `system` follows the OS; the other two pin it. Stored, because a theme that resets is a bug. */
export type Theme = 'system' | 'light' | 'dark';

/**
 * The stylesheet reads `[data-theme]`, and its absence means "follow `prefers-color-scheme`".
 * Applied at module load rather than in an effect so the first paint is already correct.
 */
function applyTheme(theme: Theme): void {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

function storedTheme(): Theme {
  const t = localStorage.getItem(THEME_KEY);
  return t === 'light' || t === 'dark' ? t : 'system';
}

/**
 * The explanation alone, unless a level was actually chosen.
 *
 * It opened one stop deeper, which meant the first thing a new reader met was several screens of
 * evidence with the diagram sharing the page with blocks nobody asked for yet. At this stop the
 * title, verdict, one sentence, and diagrams lead. Every other stop is one press away and is remembered once
 * chosen, so nothing is lost — it is the *first* impression that is being decided here, and the
 * answer to "what is this" should be the picture, not the appendix.
 *
 * Matching the strings rather than `Number(stored) || 0` is deliberate: with the default at 0,
 * `||` would now silently swallow a stored choice of `Explanation` *and* leave `Number(null)`
 * indistinguishable from it. The bug this file used to have simply changes which value it eats.
 */
function storedDetail(): Detail {
  const d = localStorage.getItem(DETAIL_KEY);
  if (d === '1') return 1;
  if (d === '2') return 2;
  return 0;
}

applyTheme(storedTheme());

/** The section summoned over the page. Nothing is a section of the document any more. */
export type PanelId = 'checks' | 'left' | 'review' | 'evidence';

interface AppState {
  api: ApiClient | undefined;
  detail: Detail;
  /** Which section is open over the document, if any. */
  panel: PanelId | undefined;
  openPanel(panel: PanelId): void;
  closePanel(): void;
  /** The session list is a surface you choose, not furniture; it folds away and stays folded. */
  sidebarOpen: boolean;
  /** Models and measured usage, in the supporting inspector shared with History. */
  statsOpen: boolean;
  /**
   * The time scrubber, at the foot of the session rather than inside a section of a panel.
   *
   * It replays the whole page as it stood at a moment, so it is a control over the document and
   * not a picture in one of its sections. Buried in a panel it was unfindable and then
   * disorienting: dragging it changed the page underneath while the reader's eye was inside a
   * drawer, so they arrived somewhere new with the control they had just used no longer in view.
   */
  rewindOpen: boolean;
  toggleRewind(): void;
  /**
   * Find-as-you-type over the session list, matched against the name, the repo and the id.
   *
   * Not stored, unlike every other choice in this file. A fold or a theme is a preference; a
   * filter is a question you are asking right now, and one that survived a reload would answer
   * the next one by hiding most of the panel with no memory of why.
   */
  sessionQuery: string;
  /** The daemon's answer for the last query it was asked; undefined until the first reply. */
  sessionSearch: SessionSearch | undefined;
  /** Group heads folded away in the session list, by name. Remembered. */
  folded: string[];
  historyMode: HistoryMode;
  /** Which kinds of change the history shows, shared by both of its views. */
  historyKinds: Facet[];
  theme: Theme;
  sessions: Record<string, SessionSummary>;
  sessionOrder: string[];
  sessionsLoaded: boolean;
  listConnection: ConnectionStatus;
  selectedId: string | undefined;
  live: Record<string, LiveSession>;
  /** Snapshot load failures, per session (cleared when a snapshot succeeds). */
  liveErrors: Record<string, LiveError | undefined>;
  rawOpen: { sessionId: string; eventId: string } | undefined;
  /**
   * What the explainer will use and when it runs, as the daemon last reported it. Undefined until
   * it answers.
   *
   * Not stored in localStorage like the other choices in this file, and that is the whole point:
   * this one is not the browser's. The daemon does the scheduling, so the daemon holds the answer,
   * and a copy kept here would be the one a second tab disagreed with.
   */
  explainer: ExplainerSettings | undefined;
  /*
   * The message, and whether it means the daemon is not answering at all. The banner used to hold
   * only the string, so it printed `daemon unreachable (Failed to fetch)` with no instruction, and
   * could not have offered one without guessing at the cause.
   */
  daemonError: { message: string; unreachable: boolean } | undefined;
  /** The daemon rejected the stored token; the gate explains how to get a fresh one. */
  authRejected: boolean;

  /** Builds the client for a token; a 401 anywhere drops the token and returns to the gate. */
  setToken(token: string): void;
  unauthorized(): void;
  setDetail(detail: Detail): void;
  loadExplainer(): void;
  setExplainerSettings(settings: ExplainerSettingsRequest): void;
  toggleSidebar(): void;
  toggleStats(): void;
  setSessionQuery(q: string): void;
  setSessionSearch(result: SessionList): void;
  toggleFold(group: string): void;
  setHistoryMode(mode: HistoryMode): void;
  setHistoryKinds(kinds: Facet[]): void;
  setTheme(theme: Theme): void;
  upsertSessions(list: SessionSummary[]): void;
  removeSession(id: string): void;
  select(id: string | undefined): void;
  setListConnection(s: ConnectionStatus): void;
  setDaemonError(e: { message: string; unreachable: boolean } | undefined): void;
  setLiveError(id: string, e: LiveError | undefined): void;
  initLive(id: string, state: RunState, changes: SemanticChange[]): void;
  applyEvents(id: string, events: StoredEvent[], changes: SemanticChange[]): void;
  setLiveConnection(id: string, s: ConnectionStatus, error?: string): void;
  setScrub(id: string, scrub: LiveSession['scrub']): void;
  markSeen(id: string): void;
  openRaw(sessionId: string, eventId: string): void;
  closeRaw(): void;
}

/** History is displayed in wall-clock order; seq breaks ties (multi-source ingest can be out of order). */
export function byTime(a: SemanticChange, b: SemanticChange): number {
  return a.ts.localeCompare(b.ts) || a.seq - b.seq || a.ordinal - b.ordinal;
}

/**
 * Salidium's own enrichment runs are agent sessions too. The daemon filters them, but a session's
 * opening summary has no title yet, so one can arrive before it is knowable — and once listed it
 * would never be corrected. Drop it here as well, and evict any that reveal themselves later.
 */
function merged(
  current: Record<string, SessionSummary>,
  list: SessionSummary[],
): Record<string, SessionSummary> {
  const sessions = { ...current };
  for (const item of list) {
    if (item.internal || item.title?.includes('[salidium-explainer]')) {
      delete sessions[item.id];
      continue;
    }
    sessions[item.id] = item;
  }
  return sessions;
}

function sortIds(sessions: Record<string, SessionSummary>): string[] {
  return Object.values(sessions)
    .sort((a, b) =>
      (b.lastEventAt ?? b.startedAt ?? '').localeCompare(a.lastEventAt ?? a.startedAt ?? ''),
    )
    .map((s) => s.id);
}

export const useAppStore = create<AppState>((set, get) => ({
  api: undefined,
  detail: storedDetail(),
  panel: undefined,
  sidebarOpen: localStorage.getItem(SIDEBAR_KEY) !== '0',
  statsOpen: localStorage.getItem(STATS_KEY) === '1',
  rewindOpen: localStorage.getItem(REWIND_KEY) === '1',
  sessionQuery: '',
  sessionSearch: undefined,
  folded: storedFolds(),
  historyMode: 'off',
  historyKinds: [...ALL_FACETS],
  theme: storedTheme(),
  sessions: {},
  sessionOrder: [],
  sessionsLoaded: false,
  listConnection: 'connecting',
  selectedId: undefined,
  live: {},
  liveErrors: {},
  rawOpen: undefined,
  explainer: undefined,
  daemonError: undefined,
  authRejected: false,

  openPanel: (panel) => set({ panel }),
  closePanel: () => set({ panel: undefined }),

  setToken: (token) =>
    set({
      api: new ApiClient(token, { onUnauthorized: () => get().unauthorized() }),
      authRejected: false,
      daemonError: undefined,
    }),
  unauthorized: () => {
    if (!get().api) return;
    clearToken();
    set({ api: undefined, authRejected: true, live: {}, liveErrors: {}, rawOpen: undefined });
  },
  setDetail: (detail) => {
    localStorage.setItem(DETAIL_KEY, String(detail));
    set({ detail });
  },
  loadExplainer: () => {
    const api = get().api;
    if (!api) return;
    // Silent on failure. The stop is a preference on a surface nobody has opened yet; a daemon
    // error banner raised by a background read would be reporting the wrong thing in the wrong
    // place, and the panel simply shows nothing until an answer arrives.
    void api.explainerSettings().then(
      (explainer) => set({ explainer }),
      () => {},
    );
  },
  setExplainerSettings: (change) => {
    const api = get().api;
    if (!api) return;
    const previous = get().explainer;
    // Move the visible choice first so every control answers immediately. The daemon's complete
    // reply then replaces it with resolved routes and environment locks from the authority.
    if (previous) set({ explainer: { ...previous, ...change } });
    void api.setExplainerSettings(change).then(
      (explainer) => set({ explainer }),
      () => set({ explainer: previous }),
    );
  },
  setTheme: (theme) => {
    localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
    set({ theme });
  },
  toggleSidebar: () =>
    set((s) => {
      const sidebarOpen = !s.sidebarOpen;
      localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? '1' : '0');
      return { sidebarOpen };
    }),
  toggleRewind: () =>
    set((s) => {
      const rewindOpen = !s.rewindOpen;
      localStorage.setItem(REWIND_KEY, rewindOpen ? '1' : '0');
      return { rewindOpen };
    }),
  toggleStats: () =>
    set((s) => {
      const statsOpen = !s.statsOpen;
      localStorage.setItem(STATS_KEY, statsOpen ? '1' : '0');
      return { statsOpen };
    }),
  setSessionQuery: (sessionQuery) => set({ sessionQuery }),
  toggleFold: (group) =>
    set((s) => {
      const folded = s.folded.includes(group)
        ? s.folded.filter((g) => g !== group)
        : [...s.folded, group];
      localStorage.setItem(SIDE_FOLDS_KEY, JSON.stringify(folded));
      return { folded };
    }),
  setHistoryMode: (historyMode) => set({ historyMode }),
  setHistoryKinds: (historyKinds) =>
    set({ historyKinds: historyKinds.length === 0 ? [...ALL_FACETS] : historyKinds }),

  upsertSessions: (list) =>
    set((s) => {
      const sessions = merged(s.sessions, list);
      return { sessions, sessionOrder: sortIds(sessions), sessionsLoaded: true };
    }),
  /*
   * A search's rows are folded into `sessions` as well as remembered as an answer. The list is
   * capped, so a match can be a fortnight older than anything the default view holds; without this
   * the row you clicked would vanish the moment you cleared the query, taking `selectedId` with it.
   * They are only ever added — `sessionOrder` is the whole client's recency order, and the answer
   * to the query is `ids`, which the panel reads instead while that query is the one on screen.
   */
  setSessionSearch: (result) =>
    set((s) => {
      // Responses can land out of order: a broad query issued two keystrokes ago is slower than the
      // narrow one issued since, and repainting the list with it would show rows for a query the
      // reader has already moved past. The abort catches most of them; this catches the rest.
      if (result.query !== s.sessionQuery.trim()) return {};
      const sessions = merged(s.sessions, result.sessions);
      return {
        sessions,
        sessionOrder: sortIds(sessions),
        sessionSearch: {
          query: result.query,
          ids: result.query ? result.sessions.map((x) => x.id) : undefined,
          matched: result.matched,
          total: result.total,
        },
      };
    }),
  removeSession: (id) =>
    set((s) => {
      const sessions = { ...s.sessions };
      delete sessions[id];
      const live = { ...s.live };
      delete live[id];
      return {
        sessions,
        sessionOrder: sortIds(sessions),
        live,
        selectedId: s.selectedId === id ? undefined : s.selectedId,
      };
    }),
  select: (id) => set({ selectedId: id, rawOpen: undefined }),
  setListConnection: (listConnection) =>
    set((s) => ({
      listConnection,
      // A healthy list stream proves the daemon is reachable again.
      daemonError: listConnection === 'open' ? undefined : s.daemonError,
    })),
  setDaemonError: (daemonError) => set({ daemonError }),
  setLiveError: (id, e) =>
    set((s) => {
      if (s.liveErrors[id] === e) return {};
      return { liveErrors: { ...s.liveErrors, [id]: e } };
    }),
  initLive: (id, state, changes) =>
    set((s) => ({
      live: {
        ...s.live,
        [id]: {
          state,
          revision: 1,
          changes: [...changes].sort(byTime),
          connection: 'connecting',
          lastSeenSeq: s.live[id]?.lastSeenSeq ?? state.latestSeq,
        },
      },
      liveErrors: s.liveErrors[id] ? { ...s.liveErrors, [id]: undefined } : s.liveErrors,
    })),
  applyEvents: (id, events, changes) => {
    const cur = get().live[id];
    if (!cur) return;
    let applied = 0;
    for (const e of events) {
      const c = applyEvent(cur.state, e);
      if (c.length) cur.changes.push(...c);
      applied++;
    }
    if (applied > 0 && changes.length === 0) cur.changes.sort(byTime);
    if (changes.length) {
      // Prefer server-provided changes for exact ordinals; dedupe by seq+ordinal.
      const have = new Set(cur.changes.map((c) => `${c.seq}:${c.ordinal}`));
      for (const c of changes) if (!have.has(`${c.seq}:${c.ordinal}`)) cur.changes.push(c);
      cur.changes.sort(byTime);
    }
    if (applied === 0 && changes.length === 0) return;
    set((s) => ({ live: { ...s.live, [id]: { ...cur, revision: cur.revision + 1 } } }));
  },
  setLiveConnection: (id, connection, error) =>
    set((s) => {
      const cur = s.live[id];
      if (!cur) return {};
      return { live: { ...s.live, [id]: { ...cur, connection, error } } };
    }),
  setScrub: (id, scrub) =>
    set((s) => {
      const cur = s.live[id];
      if (!cur) return {};
      return { live: { ...s.live, [id]: { ...cur, scrub } } };
    }),
  markSeen: (id) =>
    set((s) => {
      const cur = s.live[id];
      if (!cur) return {};
      return { live: { ...s.live, [id]: { ...cur, lastSeenSeq: cur.state.latestSeq } } };
    }),
  openRaw: (sessionId, eventId) => set({ rawOpen: { sessionId, eventId } }),
  closeRaw: () => set({ rawOpen: undefined }),
}));
