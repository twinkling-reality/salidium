import type { StoreSource } from '@salidium/adapter-kit';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../logging/logger.ts';
import type { SessionRegistry } from '../sessions/sessionRegistry.ts';
import type { SalidiumStore } from '../storage/salidiumStore.ts';
import { StoreTailer } from './storeTailer.ts';

function fakeStore(): SalidiumStore {
  return {
    pendingReingestJobs: () => [],
    allSources: () => [],
    upsertSource: () => {},
    startReingestJob: () => {},
    finishReingestJob: () => {},
  } as unknown as SalidiumStore;
}

describe('store tailer', () => {
  it('backs off from an unreadable store and logs the same error once', async () => {
    let polls = 0;
    let broken = true;
    const source: StoreSource = {
      locate: () => '/synthetic/opencode.db',
      changeIndicators: () => [],
      poll: () => {
        polls += 1;
        if (broken) throw new Error('database is locked');
        return { batches: [], more: false };
      },
      readRawRecord: () => ({ raw: undefined, reason: 'unused' }),
    };
    const warnings: string[] = [];
    const infos: string[] = [];
    const log = {
      info: (message: string) => infos.push(message),
      warn: (message: string) => warnings.push(message),
      debug: () => {},
      error: () => {},
    } as unknown as Logger;
    const tailer = new StoreTailer({
      providers: [{ id: 'salidium/opencode', source }],
      registry: {} as SessionRegistry,
      store: fakeStore(),
      log,
      env: {},
      pollIntervalMs: 60_000,
    });
    await tailer.start('/synthetic-home', 7);
    for (let i = 0; i < 5; i++) await tailer.pollNow();
    tailer.stop();
    // The first failure schedules a retry two intervals out; the polls in between are skipped.
    expect(polls).toBe(1);
    expect(warnings).toEqual(['provider store could not be read']);

    broken = false;
    const recovering = new StoreTailer({
      providers: [{ id: 'salidium/opencode', source }],
      registry: {} as SessionRegistry,
      store: fakeStore(),
      log,
      env: {},
      pollIntervalMs: 0,
    });
    broken = true;
    await recovering.start('/synthetic-home', 7);
    broken = false;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await recovering.pollNow();
    recovering.stop();
    expect(infos).toContain('provider store readable again');
  });
});
