import type { PersonalizationSettings, PersonalizedExplanation } from '@salidium/protocol';
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
