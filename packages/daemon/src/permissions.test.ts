import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startDaemon } from './daemon.ts';
import { SqliteStore } from './storage/sqliteStore.ts';

const permissions = (path: string) => statSync(path).mode & 0o777;

describe.skipIf(process.platform === 'win32')('state permissions', () => {
  it('repairs permissive existing directories and database on every start', async () => {
    const root = mkdtempSync(join(tmpdir(), 'salidium-permissions-'));
    const home = join(root, 'state');
    const spool = join(home, 'spool');
    const hooks = join(home, 'hooks');
    const db = join(home, 'salidium.db');
    mkdirSync(spool, { recursive: true, mode: 0o755 });
    mkdirSync(hooks, { recursive: true, mode: 0o755 });
    const initial = new SqliteStore(db);
    initial.close();
    chmodSync(home, 0o755);
    chmodSync(spool, 0o755);
    chmodSync(hooks, 0o755);
    chmodSync(db, 0o644);

    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
    try {
      daemon = await startDaemon({
        home,
        userHome: join(root, 'user'),
        port: 0,
        providers: [],
        gitEnrichment: false,
        historyDays: 0,
        logLevel: 'silent',
      });
      expect(permissions(home)).toBe(0o700);
      expect(permissions(spool)).toBe(0o700);
      expect(permissions(hooks)).toBe(0o700);
      expect(permissions(db)).toBe(0o600);
    } finally {
      await daemon?.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
