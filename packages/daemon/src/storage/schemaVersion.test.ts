import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, SqliteStore } from './sqliteStore.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SQLite schema compatibility', () => {
  it('refuses to read or write a store created by a newer Salidium version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'salidium-newer-schema-'));
    dirs.push(dir);
    const path = join(dir, 'db.sqlite');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      'schema_version',
      String(SCHEMA_VERSION + 1),
    );
    db.close();

    expect(() => new SqliteStore(path)).toThrow(
      new RegExp(`schema ${SCHEMA_VERSION + 1} is newer`),
    );
    expect(() => new SqliteStore(path, { readOnly: true })).toThrow(
      new RegExp(`schema ${SCHEMA_VERSION + 1} is newer`),
    );
  });
});
