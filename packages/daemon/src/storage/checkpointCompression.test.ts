import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createInitialState, REDUCER_VERSION } from '@salidium/core';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStore } from './sqliteStore.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'salidium-checkpoint-'));
  dirs.push(dir);
  const path = join(dir, 'store.db');
  const state = createInitialState({
    sessionId: 'codex:checkpoint',
    provider: 'codex',
    providerSessionId: 'checkpoint',
    cwd: '/repo',
  });
  state.latestSeq = 0;
  state.title = 'large cold state '.repeat(1000);
  return { path, state };
}

describe('versioned checkpoint compression', () => {
  it('writes large checkpoints compressed and still reads legacy plaintext rows', () => {
    const { path, state } = fixture();
    let store = new SqliteStore(path);
    store.saveCheckpoint(state.sessionId, 0, REDUCER_VERSION, state);
    store.close();

    const db = new DatabaseSync(path);
    const encoded = db.prepare('SELECT state_json FROM checkpoints').get() as {
      state_json: string;
    };
    expect(encoded.state_json.startsWith('gzip-base64:v1:')).toBe(true);
    db.prepare('UPDATE checkpoints SET state_json = ?').run(JSON.stringify(state));
    db.close();

    store = new SqliteStore(path);
    expect(store.latestCheckpoint(state.sessionId, REDUCER_VERSION)?.state).toEqual(state);
    store.close();
  });

  it('drops a corrupt compressed cache row and falls back to event replay', () => {
    const { path, state } = fixture();
    let store = new SqliteStore(path);
    store.saveCheckpoint(state.sessionId, 0, REDUCER_VERSION, state);
    store.close();

    let db = new DatabaseSync(path);
    db.prepare('UPDATE checkpoints SET state_json = ?').run('gzip-base64:v1:not-gzip');
    db.close();

    store = new SqliteStore(path);
    expect(store.latestCheckpoint(state.sessionId, REDUCER_VERSION)).toBeUndefined();
    store.close();
    db = new DatabaseSync(path, { readOnly: true });
    expect((db.prepare('SELECT COUNT(*) AS n FROM checkpoints').get() as { n: number }).n).toBe(0);
    db.close();
  });
});
