import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authorize, OpenCodeStoreConnection, withOpenCodeStore } from './storeAccess.ts';
import { SyntheticOpenCodeStore, T0, userData } from './testing/syntheticStore.ts';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'salidium-opencode-access-'));
  path = join(dir, 'opencode.db');
  const store = new SyntheticOpenCodeStore(path);
  const session = store.session({ directory: '/work/project', title: 'synthetic' });
  store.message(session, 'user', userData('hello', T0));
  store.close();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

// SQLite reports a denied column read as "access to t.c is prohibited", anything else as "not authorized".
const AUTH = /is prohibited|not authorized/i;

describe('OpenCode store connection', () => {
  it('reads the allowlisted session columns', () => {
    const rows = withOpenCodeStore(path, (store) =>
      store.all('SELECT id, directory, title FROM session_v2'),
    );
    expect(rows).toEqual([
      expect.objectContaining({ directory: '/work/project', title: 'synthetic' }),
    ]);
  });

  it.each([
    'SELECT value FROM credential',
    'SELECT * FROM credential',
    'SELECT count(*) FROM credential',
    'SELECT 1 FROM credential',
    'SELECT EXISTS(SELECT 1 FROM credential)',
    'SELECT rowid FROM credential',
    'SELECT access_token, refresh_token FROM account',
    'SELECT count(*) FROM account',
    'SELECT email FROM account',
    'SELECT access_token FROM control_account',
    'SELECT active_account_id FROM account_state',
    'SELECT id FROM session_v2 WHERE id IN (SELECT id FROM credential)',
    'SELECT s.id, c.value FROM session_v2 s JOIN credential c',
    'SELECT id FROM session_v2 UNION SELECT value FROM credential',
    'WITH secrets AS (SELECT value FROM credential) SELECT * FROM secrets',
  ])('refuses to read secrets: %s', (sql) => {
    expect(() => withOpenCodeStore(path, (store) => store.all(sql))).toThrow(AUTH);
  });

  it.each([
    // Columns of allowlisted tables that the adapter does not read.
    'SELECT cost FROM session_v2',
    'SELECT tokens_input FROM session_v2',
    'SELECT permission FROM session_v2',
    'SELECT * FROM session_v2',
    // Tables it does not read at all.
    'SELECT value FROM kv',
    'SELECT data FROM event',
    'SELECT payload FROM session_inbox',
    'SELECT worktree FROM project',
    'SELECT resource FROM permission',
    // Schema and pragmas.
    'SELECT name, sql FROM sqlite_master',
    "SELECT * FROM pragma_table_info('credential')",
    'PRAGMA table_info(credential)',
    'PRAGMA journal_mode',
    // Functions it does not need.
    'SELECT json_extract(data, "$.text") FROM session_message',
    "SELECT load_extension('x')",
    'SELECT hex(data) FROM session_message',
  ])('refuses anything outside the allowlist: %s', (sql) => {
    expect(() => withOpenCodeStore(path, (store) => store.all(sql))).toThrow(AUTH);
  });

  it.each([
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('m', 's', 'user', 9, 0, 0, '{}')",
    "UPDATE session_v2 SET title = 'x'",
    'DELETE FROM session_message',
    'CREATE TABLE salidium (x)',
    'DROP TABLE credential',
    `ATTACH DATABASE '${'other.db'}' AS other`,
    'BEGIN',
    'VACUUM',
  ])('refuses every write and state change: %s', (sql) => {
    expect(() => withOpenCodeStore(path, (store) => store.all(sql))).toThrow();
  });

  it('denies by action, table, column and database, not by query text', () => {
    expect(authorize(constants.SQLITE_READ, 'session_v2', 'id', 'main')).toBe(constants.SQLITE_OK);
    expect(authorize(constants.SQLITE_READ, 'session_v2', '', 'main')).toBe(constants.SQLITE_OK);
    expect(authorize(constants.SQLITE_READ, 'credential', '', 'main')).toBe(constants.SQLITE_DENY);
    expect(authorize(constants.SQLITE_READ, 'credential', 'value', 'main')).toBe(
      constants.SQLITE_DENY,
    );
    expect(authorize(constants.SQLITE_READ, 'session_v2', 'id', 'temp')).toBe(
      constants.SQLITE_DENY,
    );
    expect(authorize(constants.SQLITE_READ, 'session_v2', 'cost', 'main')).toBe(
      constants.SQLITE_DENY,
    );
    expect(authorize(constants.SQLITE_FUNCTION, null, 'length', null)).toBe(constants.SQLITE_OK);
    expect(authorize(constants.SQLITE_FUNCTION, null, 'json_extract', null)).toBe(
      constants.SQLITE_DENY,
    );
    expect(authorize(constants.SQLITE_PRAGMA, 'journal_mode', null, null)).toBe(
      constants.SQLITE_DENY,
    );
    expect(authorize(constants.SQLITE_ATTACH, 'x.db', null, null)).toBe(constants.SQLITE_DENY);
    expect(authorize(constants.SQLITE_INSERT, 'session_message', null, 'main')).toBe(
      constants.SQLITE_DENY,
    );
  });

  it('never writes to or copies the store', () => {
    const before = readFileSync(path);
    const mtime = statSync(path).mtimeMs;
    withOpenCodeStore(path, (store) => {
      store.all('SELECT id, data FROM session_message');
      expect(() => store.all('DELETE FROM session_message')).toThrow();
    });
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(statSync(path).mtimeMs).toBe(mtime);
    // With OpenCode stopped, SQLite itself recreates the WAL index files a WAL-mode reader needs.
    // They hold no records: the log stays empty, and no copy of the store appears.
    const extra = readdirSync(dir)
      .filter((name) => name !== 'opencode.db')
      .sort();
    expect(extra.every((name) => name === 'opencode.db-wal' || name === 'opencode.db-shm')).toBe(
      true,
    );
    if (extra.includes('opencode.db-wal')) expect(statSync(`${path}-wal`).size).toBe(0);
  });

  it('does not create a store that is not there', () => {
    expect(() => OpenCodeStoreConnection.open(join(dir, 'missing.db'))).toThrow();
    expect(readdirSync(dir)).not.toContain('missing.db');
  });
});
