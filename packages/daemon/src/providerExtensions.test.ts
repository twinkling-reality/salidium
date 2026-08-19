import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROVIDER_ADAPTER_CONTRACT_VERSION, type ProviderDescriptor } from '@salidium/adapter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { type DaemonHandle, startDaemon } from './daemon.ts';
import { createSqliteStore } from './storage/sqliteStore.ts';

let daemon: DaemonHandle | undefined;
let temporary: string | undefined;

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  if (temporary) rmSync(temporary, { recursive: true, force: true });
  temporary = undefined;
});

describe('daemon provider extensions', () => {
  it('starts from an explicitly supplied namespaced descriptor', async () => {
    temporary = mkdtempSync(join(tmpdir(), 'salidium-provider-extension-'));
    const descriptor: ProviderDescriptor = {
      contractVersion: PROVIDER_ADAPTER_CONTRACT_VERSION,
      displayName: 'Example Agent',
      adapter: {
        id: 'example/agent',
        sessionRoots: () => [],
        matchSessionFile: () => undefined,
        createRecordParser: () => ({ parseRecord: () => [] }),
        parseHookPayload: () => [],
        transcriptPathFromHook: () => undefined,
      },
    };

    let openedStorePath: string | undefined;
    daemon = await startDaemon({
      home: join(temporary, 'state'),
      userHome: join(temporary, 'user'),
      port: 0,
      historyDays: 0,
      gitEnrichment: false,
      logLevel: 'silent',
      providers: ['example/agent'],
      providerDescriptors: [descriptor],
      storeFactory: (path, options) => {
        openedStorePath = path;
        return createSqliteStore(path, options);
      },
    });

    expect(openedStorePath).toBe(join(temporary, 'state', 'salidium.db'));

    const response = await fetch(`http://127.0.0.1:${daemon.port}/api/info`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        providers: [expect.objectContaining({ id: 'example/agent', displayName: 'Example Agent' })],
      }),
    );
  });
});
