import type {
  EffectiveOperationalConfig,
  LocalAlertState,
  OperationsOverview,
  PersonalizationSettings,
  PersonalizedExplanation,
} from '@salidium/protocol';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client.ts';

let useAppStore: typeof import('./appStore.ts').useAppStore;

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  };
};

const profile = (revision: string, guidance: string): PersonalizationSettings => ({
  version: 2,
  enabled: guidance !== '',
  revision,
  profile: { guidance },
});

const presentation = (revision: string, basedOnSeq: number): PersonalizedExplanation => ({
  basedOnSeq,
  model: 'test-personalizer',
  generatedAt: '2026-08-24T12:00:00.000Z',
  profileRevision: revision,
  what: { summary: 'The same factual summary.', currently: null },
  why: { summary: 'A familiar explanation.', lanes: [], chain: ['One safe step'] },
  how: { summary: 'A familiar method.', root: 'root', steps: ['One safe step'] },
  approachChange: null,
  analogies: { why: null, how: null },
});

const operationalConfig = (revision: number, queueAgeMinutes: number) =>
  ({
    revision,
    values: {
      alerts: {
        queueAgeMinutes: { value: queueAgeMinutes, source: revision ? 'stored' : 'default' },
      },
    },
  }) as unknown as EffectiveOperationalConfig;

const operations = (revision: number, queueAgeMinutes: number): OperationsOverview =>
  ({
    config: operationalConfig(revision, queueAgeMinutes),
    health: {
      observedAt: `2026-08-24T12:00:0${revision}.000Z`,
      overall: 'healthy',
      collection: {
        state: 'active',
        pausedAt: null,
        pauseExpiresAt: null,
        pauseReason: null,
      },
      queue: { files: 0, bytes: 0, oldestAt: null },
      store: { totalBytes: 0, retention: 'forever', lastIngestAt: null },
      gaps: { activeEpisodes: [], recoveredEpisodes: [], omitted: 0 },
    },
    alerts: { contractVersion: 1, observedAt: '2026-08-24T12:00:00.000Z', active: [], recent: [] },
  }) as unknown as OperationsOverview;

beforeAll(async () => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('document', { documentElement: { dataset: {} } });
  useAppStore = (await import('./appStore.ts')).useAppStore;
});

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
});

describe('personalization store lifecycle', () => {
  it('does not let an older profile read overwrite a completed save', async () => {
    let finishRead = (_value: PersonalizationSettings) => undefined;
    const delayedRead = new Promise<PersonalizationSettings>((resolve) => {
      finishRead = resolve;
    });
    const api = {
      personalizationSettings: () => delayedRead,
      setPersonalizationSettings: async () => profile('r2', 'kitchen'),
    } as unknown as ApiClient;
    useAppStore.setState({ api, personalization: profile('r1', 'soccer') });

    useAppStore.getState().loadPersonalization();
    await useAppStore
      .getState()
      .savePersonalization({ enabled: true, profile: { guidance: 'kitchen' } });
    finishRead(profile('r1', 'soccer'));
    await Promise.resolve();

    expect(useAppStore.getState().personalization).toEqual(profile('r2', 'kitchen'));
  });

  it('clears browser-only presentations when a newer profile revision is observed', async () => {
    const api = {
      personalizationSettings: async () => profile('r2', 'kitchen'),
    } as unknown as ApiClient;
    useAppStore.setState({
      api,
      personalization: profile('r1', 'soccer'),
      personalized: { s1: presentation('r1', 4) },
    });

    useAppStore.getState().loadPersonalization();
    await vi.waitFor(() => expect(useAppStore.getState().personalization?.revision).toBe('r2'));
    expect(useAppStore.getState().personalized).toEqual({});
  });

  it('rejects a result when the explanation changed while generation was running', async () => {
    const api = {
      personalizedPresentation: async () => presentation('r1', 4),
    } as unknown as ApiClient;
    useAppStore.setState({
      api,
      personalization: profile('r1', 'soccer'),
      live: {
        s1: {
          state: { explained: { basedOnSeq: 5 } },
          revision: 1,
          changes: [],
          connection: 'open',
          lastSeenSeq: 0,
        },
      } as never,
    });

    await expect(useAppStore.getState().personalizeSession('s1')).rejects.toThrow(
      'explanation changed',
    );
    expect(useAppStore.getState().personalized).toEqual({});
  });

  it('drops daemon-owned and browser-only personalization after authorization is lost', () => {
    useAppStore.setState({
      api: {} as ApiClient,
      personalization: profile('r1', 'soccer'),
      personalized: { s1: presentation('r1', 4) },
    });

    useAppStore.getState().unauthorized();

    expect(useAppStore.getState().personalization).toBeUndefined();
    expect(useAppStore.getState().personalized).toEqual({});
  });
});

describe('daemon connection lifecycle', () => {
  it('reports a stream lost after the initial list loaded and clears it when the stream recovers', () => {
    useAppStore.setState({
      listConnection: 'open',
      daemonError: undefined,
    });

    useAppStore.getState().setListConnection('reconnecting');

    expect(useAppStore.getState().daemonError).toEqual({
      message: 'connection to the daemon was lost',
      unreachable: true,
    });
    expect(useAppStore.getState().listConnection).toBe('reconnecting');

    useAppStore.getState().setListConnection('open');

    expect(useAppStore.getState().daemonError).toBeUndefined();
  });

  it('does not call an initial connection attempt an outage', () => {
    useAppStore.getState().setListConnection('connecting');

    expect(useAppStore.getState().daemonError).toBeUndefined();
  });
});

describe('operations store lifecycle', () => {
  it('does not let an older health poll overwrite an accepted policy write', async () => {
    let finishPoll = (_value: OperationsOverview) => undefined;
    const delayedPoll = new Promise<OperationsOverview>((resolve) => {
      finishPoll = resolve;
    });
    const updated = operationalConfig(1, 30);
    const api = {
      operations: () => delayedPoll,
      info: async () => ({ home: '/tmp/salidium', providers: [] }),
      setOperationalConfig: async () => updated,
    } as unknown as ApiClient;
    useAppStore.setState({ api, operations: operations(0, 10) });

    useAppStore.getState().loadCollection();
    await useAppStore.getState().setOperationalConfig({ alerts: { queueAgeMinutes: 30 } });
    finishPoll(operations(0, 10));
    await Promise.resolve();
    await Promise.resolve();

    expect(useAppStore.getState().operations?.config).toBe(updated);
    expect(useAppStore.getState().operations?.config.revision).toBe(1);
    expect(useAppStore.getState().operationsPending).toBeUndefined();
  });

  it('merges acknowledged alerts into the latest health and configuration snapshot', async () => {
    let finishAcknowledge = (_value: LocalAlertState) => undefined;
    const acknowledged = new Promise<LocalAlertState>((resolve) => {
      finishAcknowledge = resolve;
    });
    const api = { acknowledgeAlert: () => acknowledged } as unknown as ApiClient;
    useAppStore.setState({ api, operations: operations(0, 10) });

    const request = useAppStore.getState().acknowledgeAlert('queue-age');
    const latest = operations(2, 60);
    useAppStore.setState({ operations: latest });
    const alerts: LocalAlertState = {
      contractVersion: 1,
      observedAt: '2026-08-24T12:00:03.000Z',
      active: [],
      recent: [],
    };
    finishAcknowledge(alerts);
    await request;

    expect(useAppStore.getState().operations?.health).toBe(latest.health);
    expect(useAppStore.getState().operations?.config).toBe(latest.config);
    expect(useAppStore.getState().operations?.alerts).toBe(alerts);
  });

  it('keeps an action failure visible after a successful background refresh', async () => {
    const api = {
      acknowledgeAlert: async () => {
        throw new Error('request failed: 500');
      },
      operations: async () => operations(1, 30),
      info: async () => ({ home: '/tmp/salidium', providers: [] }),
    } as unknown as ApiClient;
    useAppStore.setState({ api, operations: operations(0, 10) });

    await expect(useAppStore.getState().acknowledgeAlert('queue-age')).rejects.toThrow(
      'request failed: 500',
    );
    useAppStore.getState().loadCollection();
    await vi.waitFor(() => expect(useAppStore.getState().operations?.config.revision).toBe(1));

    expect(useAppStore.getState().operationsActionError).toBe('request failed: 500');
  });
});
