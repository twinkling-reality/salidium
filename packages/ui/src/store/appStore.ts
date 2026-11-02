import { applyEvent, type RunState, reviveState } from '@salidium/core';
import type {
  CollectionStatus,
  DaemonInfo,
  ExplainerSettings,
  ExplainerSettingsRequest,
  Facet,
  OperationalConfigPatch,
  OperationsOverview,
  PersonalizationSettings,
  PersonalizationSettingsRequest,
  PersonalizedExplanation,
  SemanticChange,
  SessionList,
  SessionSummary,
  StorageCompactResult,
  StorageDeletionResult,
  StorageDeletionScope,
  StoredEvent,
} from '@salidium/protocol';
import { create } from 'zustand';
import { ApiClient, clearToken } from '../api/client.ts';
import {
  type CanvasStyleConfig,
  DEFAULT_CANVAS_STYLE_CONFIG,
  loadCanvasStyleConfig,
  saveCanvasStyleConfig,
} from '../lib/visualPresets.ts';
import {
  ALL_FACETS,
  byTime,
  type ConnectionStatus,
  collectionFromOperations,
  errorMessage,
  type LiveError,
  type LiveSession,
  merged,
  type OperationsAction,
  type SessionSearch,
  sortIds,
} from './sessionStoreHelpers.ts';
import {
  applyTheme,
  CANVAS_BLAST_KEY,
  CANVAS_DENSITY_KEY,
  CANVAS_LENS_KEY,
  CANVAS_STYLE_KEY,
  CANVAS_VERIF_KEY,
  type CanvasDensity,
  type CanvasLens,
  type CanvasStyle,
  DETAIL_KEY,
  type Detail,
  type HistoryMode,
  INGEST_KEY,
  type PanelId,
  REWIND_KEY,
  SIDE_FOLDS_KEY,
  SIDEBAR_KEY,
  STATS_KEY,
  storageGet,
  storageSet,
  storedCanvasDensity,
  storedCanvasLens,
  storedCanvasStyle,
  storedDetail,
  storedFolds,
  storedTheme,
  THEME_KEY,
  type Theme,
} from './storagePreferences.ts';

export {
  ALL_FACETS,
  byTime,
  type ConnectionStatus,
  type LiveError,
  type LiveSession,
  type OperationsAction,
  type SessionSearch,
} from './sessionStoreHelpers.ts';
export {
  type CanvasDensity,
  type CanvasLens,
  type CanvasStyle,
  type Detail,
  type HistoryMode,
  NOTHING_RECORDED,
  type PanelId,
  type Theme,
} from './storagePreferences.ts';

applyTheme(storedTheme());

interface AppState {
  api: ApiClient | undefined;
  detail: Detail;
  panel: PanelId | undefined;
  openPanel(panel: PanelId): void;
  closePanel(): void;
  sidebarOpen: boolean;
  statsOpen: boolean;
  ingestOpen: boolean;
  ingestFocus: 'storage' | 'operations' | undefined;
  rewindOpen: boolean;
  toggleRewind(): void;
  sessionQuery: string;
  sessionSearch: SessionSearch | undefined;
  folded: string[];
  historyMode: HistoryMode;
  historyKinds: Facet[];
  theme: Theme;
  canvasLens: CanvasLens;
  canvasStyle: CanvasStyle;
  canvasDensity: CanvasDensity;
  canvasBlastRadius: boolean;
  canvasVerification: boolean;
  canvasStyleConfig: CanvasStyleConfig;
  sessions: Record<string, SessionSummary>;
  sessionOrder: string[];
  sessionsLoaded: boolean;
  listConnection: ConnectionStatus;
  selectedId: string | undefined;
  live: Record<string, LiveSession>;
  liveErrors: Record<string, LiveError | undefined>;
  rawOpen: { sessionId: string; eventId: string } | undefined;
  explainer: ExplainerSettings | undefined;
  operations: OperationsOverview | undefined;
  collection: CollectionStatus | undefined;
  collectionInfo: DaemonInfo | undefined;
  collectionLoading: boolean;
  collectionError: string | undefined;
  operationsPending: OperationsAction | undefined;
  operationsActionError: string | undefined;
  personalization: PersonalizationSettings | undefined;
  personalizationLoading: boolean;
  personalizationLoadError: string | undefined;
  personalized: Record<string, PersonalizedExplanation | undefined>;
  daemonError: { message: string; unreachable: boolean } | undefined;
  authRejected: boolean;

  setToken(token: string): void;
  unauthorized(): void;
  setDetail(detail: Detail): void;
  loadExplainer(): void;
  loadCollection(): void;
  setOperationalConfig(settings: OperationalConfigPatch): Promise<void>;
  resetOperationalConfig(key?: string): Promise<void>;
  drainQueue(): Promise<void>;
  acknowledgeAlert(id: string): Promise<void>;
  setCollection(action: 'pause' | 'resume'): Promise<void>;
  disconnectHooks(provider: string): Promise<void>;
  connectHooks(provider: string): Promise<void>;
  forgetSession(sessionId: string): Promise<void>;
  deleteStorage(
    scope: StorageDeletionScope,
    expectedSessions?: number,
  ): Promise<StorageDeletionResult>;
  compactStorage(): Promise<StorageCompactResult>;
  loadPersonalization(): void;
  setExplainerSettings(settings: ExplainerSettingsRequest): void;
  savePersonalization(settings: PersonalizationSettingsRequest): Promise<void>;
  deletePersonalization(): Promise<void>;
  personalizeSession(sessionId: string): Promise<void>;
  toggleSidebar(): void;
  toggleStats(): void;
  toggleIngest(): void;
  openIngest(focus?: 'storage' | 'operations'): void;
  clearIngestFocus(): void;
  setSessionQuery(q: string): void;
  setSessionSearch(result: SessionList): void;
  toggleFold(group: string): void;
  setHistoryMode(mode: HistoryMode): void;
  setHistoryKinds(kinds: Facet[]): void;
  setTheme(theme: Theme): void;
  setCanvasLens(lens: CanvasLens): void;
  setCanvasStyle(style: CanvasStyle): void;
  setCanvasDensity(density: CanvasDensity): void;
  toggleCanvasBlastRadius(): void;
  toggleCanvasVerification(): void;
  updateCanvasStyleConfig(patch: Partial<CanvasStyleConfig>): void;
  resetCanvasStyleConfig(): void;
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

/** Invalidates older profile reads when a write, reconnect, or newer read overtakes them. */
let personalizationLoadGeneration = 0;
/** Invalidates older operations reads when a mutation, reconnect, or newer read overtakes them. */
let operationsLoadGeneration = 0;

export const useAppStore = create<AppState>((set, get) => ({
  api: undefined,
  detail: storedDetail(),
  panel: undefined,
  sidebarOpen: storageGet(SIDEBAR_KEY) !== '0',
  statsOpen: storageGet(STATS_KEY) === '1',
  ingestOpen: storageGet(INGEST_KEY) === '1',
  ingestFocus: undefined,
  rewindOpen: storageGet(REWIND_KEY) === '1',
  sessionQuery: '',
  sessionSearch: undefined,
  folded: storedFolds(),
  historyMode: 'off',
  historyKinds: [...ALL_FACETS],
  theme: storedTheme(),
  canvasLens: storedCanvasLens(),
  canvasStyle: storedCanvasStyle(),
  canvasDensity: storedCanvasDensity(),
  canvasBlastRadius: storageGet(CANVAS_BLAST_KEY) !== '0',
  canvasVerification: storageGet(CANVAS_VERIF_KEY) !== '0',
  canvasStyleConfig: loadCanvasStyleConfig(),
  sessions: {},
  sessionOrder: [],
  sessionsLoaded: false,
  listConnection: 'connecting',
  selectedId: undefined,
  live: {},
  liveErrors: {},
  rawOpen: undefined,
  explainer: undefined,
  operations: undefined,
  collection: undefined,
  collectionInfo: undefined,
  collectionLoading: false,
  collectionError: undefined,
  operationsPending: undefined,
  operationsActionError: undefined,
  personalization: undefined,
  personalizationLoading: false,
  personalizationLoadError: undefined,
  personalized: {},
  daemonError: undefined,
  authRejected: false,

  openPanel: (panel) => set({ panel }),
  closePanel: () => set({ panel: undefined }),

  setToken: (token) => {
    personalizationLoadGeneration++;
    operationsLoadGeneration++;
    set({
      api: new ApiClient(token, { onUnauthorized: () => get().unauthorized() }),
      authRejected: false,
      daemonError: undefined,
      personalization: undefined,
      operations: undefined,
      collection: undefined,
      collectionInfo: undefined,
      collectionLoading: false,
      collectionError: undefined,
      operationsPending: undefined,
      operationsActionError: undefined,
      personalizationLoading: false,
      personalizationLoadError: undefined,
      personalized: {},
    });
  },
  unauthorized: () => {
    if (!get().api) return;
    personalizationLoadGeneration++;
    operationsLoadGeneration++;
    clearToken();
    set({
      api: undefined,
      authRejected: true,
      live: {},
      liveErrors: {},
      rawOpen: undefined,
      explainer: undefined,
      operations: undefined,
      collection: undefined,
      collectionInfo: undefined,
      collectionLoading: false,
      collectionError: undefined,
      operationsPending: undefined,
      operationsActionError: undefined,
      personalization: undefined,
      personalizationLoading: false,
      personalizationLoadError: undefined,
      personalized: {},
    });
  },
  setDetail: (detail) => {
    storageSet(DETAIL_KEY, String(detail));
    set({ detail });
  },
  loadExplainer: () => {
    const api = get().api;
    if (!api) return;
    void api.explainerSettings().then(
      (explainer) => set({ explainer }),
      () => {},
    );
  },
  loadCollection: () => {
    const api = get().api;
    if (!api || get().operationsPending) return;
    const request = ++operationsLoadGeneration;
    if (!get().operations) set({ collectionLoading: true, collectionError: undefined });
    void Promise.all([api.operations(), api.info()]).then(
      ([operations, collectionInfo]) => {
        if (request !== operationsLoadGeneration || api !== get().api) return;
        set({
          operations,
          collection: collectionFromOperations(operations),
          collectionInfo,
          collectionLoading: false,
          collectionError: undefined,
        });
      },
      (error) => {
        if (request !== operationsLoadGeneration || api !== get().api) return;
        set({
          collectionLoading: false,
          collectionError: errorMessage(error),
        });
      },
    );
  },
  setCollection: async (action) => {
    const api = get().api;
    if (!api) {
      set({ operationsActionError: 'daemon is not connected' });
      return;
    }
    if (get().operationsPending) throw new Error('another operations action is still running');
    const request = ++operationsLoadGeneration;
    set({ operationsPending: 'collection', operationsActionError: undefined });
    try {
      const collection = await api.setCollection(action);
      const operations = await api.operations();
      if (request === operationsLoadGeneration && api === get().api)
        set({ collection, operations, operationsPending: undefined });
    } catch (error) {
      if (request === operationsLoadGeneration && api === get().api)
        set({
          operationsPending: undefined,
          operationsActionError: errorMessage(error),
        });
    }
  },
  setOperationalConfig: async (settings) => {
    const api = get().api;
    const current = get().operations;
    if (!api || !current) throw new Error('operational configuration is not loaded');
    if (get().operationsPending) throw new Error('another operations action is still running');
    const request = ++operationsLoadGeneration;
    set({ operationsPending: 'policy', operationsActionError: undefined });
    try {
      const config = await api.setOperationalConfig(settings, current.config.revision);
      if (request === operationsLoadGeneration && api === get().api)
        set((state) => ({
          operations: state.operations ? { ...state.operations, config } : state.operations,
          operationsPending: undefined,
        }));
    } catch (error) {
      if (request === operationsLoadGeneration && api === get().api)
        set({
          operationsPending: undefined,
          operationsActionError: errorMessage(error),
        });
      throw error;
    }
  },
  resetOperationalConfig: async (key) => {
    const api = get().api;
    const current = get().operations;
    if (!api || !current) throw new Error('operational configuration is not loaded');
    if (get().operationsPending) throw new Error('another operations action is still running');
    const request = ++operationsLoadGeneration;
    set({ operationsPending: 'reset', operationsActionError: undefined });
    try {
      const config = await api.resetOperationalConfig(key, current.config.revision);
      if (request === operationsLoadGeneration && api === get().api)
        set((state) => ({
          operations: state.operations ? { ...state.operations, config } : state.operations,
          operationsPending: undefined,
        }));
    } catch (error) {
      if (request === operationsLoadGeneration && api === get().api)
        set({ operationsPending: undefined, operationsActionError: errorMessage(error) });
      throw error;
    }
  },
  drainQueue: async () => {
    const api = get().api;
    if (!api) throw new Error('daemon is not connected');
    if (get().operationsPending) throw new Error('another operations action is still running');
    const request = ++operationsLoadGeneration;
    set({ operationsPending: 'drain', operationsActionError: undefined });
    try {
      await api.drainQueue();
      const operations = await api.operations();
      if (request === operationsLoadGeneration && api === get().api)
        set({
          operations,
          collection: collectionFromOperations(operations),
          operationsPending: undefined,
        });
    } catch (error) {
      if (request === operationsLoadGeneration && api === get().api)
        set({
          operationsPending: undefined,
          operationsActionError: errorMessage(error),
        });
      throw error;
    }
  },
  acknowledgeAlert: async (id) => {
    const api = get().api;
    if (!api || !get().operations) throw new Error('operations are not loaded');
    if (get().operationsPending) throw new Error('another operations action is still running');
    const request = ++operationsLoadGeneration;
    set({ operationsPending: 'alert', operationsActionError: undefined });
    try {
      const alerts = await api.acknowledgeAlert(id);
      if (request === operationsLoadGeneration && api === get().api)
        set((state) => ({
          operations: state.operations ? { ...state.operations, alerts } : state.operations,
          operationsPending: undefined,
        }));
    } catch (error) {
      if (request === operationsLoadGeneration && api === get().api)
        set({ operationsPending: undefined, operationsActionError: errorMessage(error) });
      throw error;
    }
  },
  disconnectHooks: async (provider) => {
    const api = get().api;
    if (!api) {
      set({ operationsActionError: 'daemon is not connected' });
      return;
    }
    if (get().operationsPending) throw new Error('another operations action is still running');
    const request = ++operationsLoadGeneration;
    set({ operationsPending: 'disconnect', operationsActionError: undefined });
    try {
      const collection = await api.disconnectHooks(provider);
      const collectionInfo = await api.info();
      const operations = await api.operations();
      if (request === operationsLoadGeneration && api === get().api)
        set({ collection, operations, collectionInfo, operationsPending: undefined });
    } catch (error) {
      if (request === operationsLoadGeneration && api === get().api)
        set({
          operationsPending: undefined,
          operationsActionError: errorMessage(error),
        });
    }
  },
  connectHooks: async (provider) => {
    const api = get().api;
    if (!api) {
      set({ operationsActionError: 'daemon is not connected' });
      return;
    }
    if (get().operationsPending) throw new Error('another operations action is still running');
    const request = ++operationsLoadGeneration;
    set({ operationsPending: 'connect', operationsActionError: undefined });
    try {
      const collection = await api.connectHooks(provider);
      const collectionInfo = await api.info();
      const operations = await api.operations();
      if (request === operationsLoadGeneration && api === get().api)
        set({ collection, operations, collectionInfo, operationsPending: undefined });
    } catch (error) {
      if (request === operationsLoadGeneration && api === get().api)
        set({
          operationsPending: undefined,
          operationsActionError: errorMessage(error),
        });
    }
  },
  forgetSession: async (sessionId) => {
    const api = get().api;
    if (!api) throw new Error('daemon is not connected');
    await api.deleteStorage({ kind: 'session', sessionId });
    get().removeSession(sessionId);
    if (get().operations) get().loadCollection();
  },
  deleteStorage: async (scope, expectedSessions) => {
    const api = get().api;
    if (!api) throw new Error('daemon is not connected');
    if (get().operationsPending) throw new Error('another operations action is still running');
    const request = ++operationsLoadGeneration;
    set({ operationsPending: 'storage-delete', operationsActionError: undefined });
    try {
      const result = await api.deleteStorage(scope, expectedSessions);
      const [operations, list] = await Promise.all([api.operations(), api.sessions()]);
      if (request === operationsLoadGeneration && api === get().api) {
        if (scope.kind === 'all') {
          set({
            sessions: {},
            sessionOrder: [],
            sessionSearch: undefined,
            live: {},
            liveErrors: {},
            personalized: {},
            selectedId: undefined,
            rawOpen: undefined,
            operations,
            collection: collectionFromOperations(operations),
            operationsPending: undefined,
          });
        } else {
          const sessions = merged({}, list);
          const sessionOrder = sortIds(sessions);
          const live = Object.fromEntries(
            Object.entries(get().live).filter(([id]) => Boolean(sessions[id])),
          );
          const liveErrors = Object.fromEntries(
            Object.entries(get().liveErrors).filter(([id]) => Boolean(sessions[id])),
          );
          const personalized = Object.fromEntries(
            Object.entries(get().personalized).filter(([id]) => Boolean(sessions[id])),
          );
          const prevSearch = get().sessionSearch;
          const sessionSearch = prevSearch
            ? {
                ...prevSearch,
                ids: prevSearch.ids?.filter((id) => Boolean(sessions[id])),
              }
            : undefined;
          const prevRaw = get().rawOpen;
          const rawOpen = prevRaw && sessions[prevRaw.sessionId] ? prevRaw : undefined;
          const currentSelected = get().selectedId;
          const selectedId =
            currentSelected && sessions[currentSelected] ? currentSelected : sessionOrder[0];
          set({
            sessions,
            sessionOrder,
            sessionSearch,
            live,
            liveErrors,
            personalized,
            rawOpen,
            selectedId,
            operations,
            collection: collectionFromOperations(operations),
            operationsPending: undefined,
          });
        }
      }
      return result;
    } catch (error) {
      if (request === operationsLoadGeneration && api === get().api)
        set({
          operationsPending: undefined,
          operationsActionError: errorMessage(error),
        });
      throw error;
    }
  },
  compactStorage: async () => {
    const api = get().api;
    if (!api) throw new Error('daemon is not connected');
    if (get().operationsPending) throw new Error('another operations action is still running');
    const request = ++operationsLoadGeneration;
    set({ operationsPending: 'storage-compact', operationsActionError: undefined });
    try {
      const result = await api.compactStorage();
      const operations = await api.operations();
      if (request === operationsLoadGeneration && api === get().api)
        set({
          operations,
          collection: collectionFromOperations(operations),
          operationsPending: undefined,
        });
      return result;
    } catch (error) {
      if (request === operationsLoadGeneration && api === get().api)
        set({
          operationsPending: undefined,
          operationsActionError: errorMessage(error),
        });
      throw error;
    }
  },
  loadPersonalization: () => {
    const api = get().api;
    if (!api) return;
    const request = ++personalizationLoadGeneration;
    set({ personalizationLoading: true, personalizationLoadError: undefined });
    void api.personalizationSettings().then(
      (personalization) => {
        if (request !== personalizationLoadGeneration || api !== get().api) return;
        const previous = get().personalization;
        set({
          personalization,
          personalizationLoading: false,
          personalizationLoadError: undefined,
          ...(previous && previous.revision !== personalization.revision
            ? { personalized: {} }
            : {}),
        });
      },
      () => {
        if (request !== personalizationLoadGeneration || api !== get().api) return;
        set({
          personalizationLoading: false,
          personalizationLoadError: 'Could not load saved terms.',
        });
      },
    );
  },
  setExplainerSettings: (change) => {
    const api = get().api;
    if (!api) return;
    const previous = get().explainer;
    if (previous) set({ explainer: { ...previous, ...change } });
    void api.setExplainerSettings(change).then(
      (explainer) => set({ explainer }),
      () => set({ explainer: previous }),
    );
  },
  savePersonalization: async (profile) => {
    const api = get().api;
    const current = get().personalization;
    if (!api || !current) throw new Error('personalization is not loaded');
    personalizationLoadGeneration++;
    try {
      const personalization = await api.setPersonalizationSettings(profile, current.revision);
      set({
        personalization,
        personalizationLoading: false,
        personalizationLoadError: undefined,
        personalized: {},
      });
    } catch (err) {
      if (err instanceof Error && 'status' in err && err.status === 409)
        get().loadPersonalization();
      throw err;
    }
  },
  deletePersonalization: async () => {
    const api = get().api;
    const current = get().personalization;
    if (!api || !current) throw new Error('personalization is not loaded');
    personalizationLoadGeneration++;
    try {
      const personalization = await api.deletePersonalizationSettings(current.revision);
      set({
        personalization,
        personalizationLoading: false,
        personalizationLoadError: undefined,
        personalized: {},
      });
    } catch (err) {
      if (err instanceof Error && 'status' in err && err.status === 409)
        get().loadPersonalization();
      throw err;
    }
  },
  personalizeSession: async (sessionId) => {
    const api = get().api;
    if (!api) throw new Error('daemon is not connected');
    const presentation = await api.personalizedPresentation(sessionId);
    const currentProfile = get().personalization;
    const currentExplanation = get().live[sessionId]?.state.explained;
    if (
      !currentProfile ||
      presentation.profileRevision !== currentProfile.revision ||
      presentation.basedOnSeq !== currentExplanation?.basedOnSeq
    )
      throw new Error('the explanation changed while personalization was running');
    set((state) => ({ personalized: { ...state.personalized, [sessionId]: presentation } }));
  },
  setTheme: (theme) => {
    storageSet(THEME_KEY, theme);
    applyTheme(theme);
    set({ theme });
  },
  setCanvasLens: (canvasLens) => {
    storageSet(CANVAS_LENS_KEY, canvasLens);
    set({ canvasLens });
  },
  setCanvasStyle: (canvasStyle) => {
    storageSet(CANVAS_STYLE_KEY, canvasStyle);
    set({ canvasStyle });
  },
  setCanvasDensity: (canvasDensity) => {
    storageSet(CANVAS_DENSITY_KEY, canvasDensity);
    set({ canvasDensity });
  },
  toggleCanvasBlastRadius: () =>
    set((s) => {
      const canvasBlastRadius = !s.canvasBlastRadius;
      storageSet(CANVAS_BLAST_KEY, canvasBlastRadius ? '1' : '0');
      return { canvasBlastRadius };
    }),
  toggleCanvasVerification: () =>
    set((s) => {
      const canvasVerification = !s.canvasVerification;
      storageSet(CANVAS_VERIF_KEY, canvasVerification ? '1' : '0');
      return { canvasVerification };
    }),
  updateCanvasStyleConfig: (patch) =>
    set((s) => {
      const canvasStyleConfig: CanvasStyleConfig = {
        ...s.canvasStyleConfig,
        ...patch,
        sections: {
          ...s.canvasStyleConfig.sections,
          ...(patch.sections ?? {}),
        },
      };
      saveCanvasStyleConfig(canvasStyleConfig);
      return { canvasStyleConfig };
    }),
  resetCanvasStyleConfig: () =>
    set(() => {
      saveCanvasStyleConfig(DEFAULT_CANVAS_STYLE_CONFIG);
      return { canvasStyleConfig: DEFAULT_CANVAS_STYLE_CONFIG };
    }),
  toggleSidebar: () =>
    set((s) => {
      const sidebarOpen = !s.sidebarOpen;
      storageSet(SIDEBAR_KEY, sidebarOpen ? '1' : '0');
      return { sidebarOpen };
    }),
  toggleRewind: () =>
    set((s) => {
      const rewindOpen = !s.rewindOpen;
      storageSet(REWIND_KEY, rewindOpen ? '1' : '0');
      return { rewindOpen };
    }),
  toggleStats: () =>
    set((s) => {
      const statsOpen = !s.statsOpen;
      storageSet(STATS_KEY, statsOpen ? '1' : '0');
      if (statsOpen) storageSet(INGEST_KEY, '0');
      return { statsOpen, ...(statsOpen ? { ingestOpen: false } : {}) };
    }),
  toggleIngest: () =>
    set((s) => {
      const ingestOpen = !s.ingestOpen;
      storageSet(INGEST_KEY, ingestOpen ? '1' : '0');
      if (ingestOpen) storageSet(STATS_KEY, '0');
      return { ingestOpen, ingestFocus: undefined, ...(ingestOpen ? { statsOpen: false } : {}) };
    }),
  openIngest: (focus) => {
    storageSet(INGEST_KEY, '1');
    storageSet(STATS_KEY, '0');
    set({ ingestOpen: true, ingestFocus: focus, statsOpen: false, historyMode: 'off' });
  },
  clearIngestFocus: () => set({ ingestFocus: undefined }),
  setSessionQuery: (sessionQuery) => set({ sessionQuery }),
  toggleFold: (group) =>
    set((s) => {
      const folded = s.folded.includes(group)
        ? s.folded.filter((g) => g !== group)
        : [...s.folded, group];
      storageSet(SIDE_FOLDS_KEY, JSON.stringify(folded));
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
  setSessionSearch: (result) =>
    set((s) => {
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
      const sessionOrder = sortIds(sessions);
      const live = { ...s.live };
      delete live[id];
      const liveErrors = { ...s.liveErrors };
      delete liveErrors[id];
      const personalized = { ...s.personalized };
      delete personalized[id];
      const sessionSearch = s.sessionSearch
        ? {
            ...s.sessionSearch,
            ids: s.sessionSearch.ids?.filter((item) => item !== id),
          }
        : undefined;
      return {
        sessions,
        sessionOrder,
        sessionSearch,
        live,
        liveErrors,
        personalized,
        rawOpen: s.rawOpen?.sessionId === id ? undefined : s.rawOpen,
        selectedId: s.selectedId === id ? sessionOrder[0] : s.selectedId,
      };
    }),
  select: (id) => set({ selectedId: id, rawOpen: undefined }),
  setListConnection: (listConnection) =>
    set((s) => ({
      listConnection,
      daemonError:
        listConnection === 'open'
          ? undefined
          : listConnection === 'reconnecting' || listConnection === 'closed'
            ? {
                message: 'connection to the daemon was lost',
                unreachable: true,
              }
            : s.daemonError,
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
          state: reviveState(state),
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
