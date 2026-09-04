import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  renameSync,
  statfsSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  decodeCheckpointValue,
  decodeEventJsonValue,
  encodeCheckpointValue,
  encodeEventJson,
  OPTIMIZED_STORE_PAGE_SIZE,
  SCHEMA_VERSION,
  SqliteStore,
  STORAGE_LAYOUT_VERSION,
} from './sqliteStore.ts';

type SqlValue = string | Uint8Array;

export interface StoreLayoutInspection {
  schemaVersion: number | null;
  layoutVersion: number | null;
  pageSize: number;
  eventsWithoutRowid: boolean;
  eventJsonType: string | null;
  checkpointType: string | null;
  optimized: boolean;
}

export interface StoreOptimizationResult {
  alreadyOptimized: boolean;
  beforeBytes: number;
  afterBytes: number;
  requiredFreeBytes: number;
  eventRows: number;
  checkpointRows: number;
  sourceDigest: string;
  targetDigest: string;
  layout: StoreLayoutInspection;
}

export interface StoreOptimizationOptions {
  availableBytes?: number;
  now?: Date;
  onProgress?: (stage: string) => void;
}

function scalarNumber(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as Record<string, number | bigint> | undefined;
  const value = row ? Object.values(row)[0] : undefined;
  return Number(value ?? 0);
}

function metaNumber(db: DatabaseSync, key: string): number | null {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value?: string }
      | undefined;
    const value = Number(row?.value);
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

function columnType(db: DatabaseSync, table: string, column: string): string | null {
  const rows = db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<{
    name: string;
    type: string;
  }>;
  return rows.find((row) => row.name === column)?.type.toUpperCase() ?? null;
}

export function inspectStoreLayout(path: string): StoreLayoutInspection {
  if (!existsSync(path)) throw new Error(`no store at ${path}`);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'")
      .get() as { sql?: string } | undefined;
    const pageSize = scalarNumber(db, 'PRAGMA page_size');
    const schemaVersion = metaNumber(db, 'schema_version');
    const layoutVersion = metaNumber(db, 'storage_layout_version');
    const eventsWithoutRowid = /WITHOUT\s+ROWID/i.test(row?.sql ?? '');
    const eventJsonType = columnType(db, 'events', 'json');
    const checkpointType = columnType(db, 'checkpoints', 'state_json');
    return {
      schemaVersion,
      layoutVersion,
      pageSize,
      eventsWithoutRowid,
      eventJsonType,
      checkpointType,
      optimized:
        schemaVersion === SCHEMA_VERSION &&
        layoutVersion === STORAGE_LAYOUT_VERSION &&
        pageSize === OPTIMIZED_STORE_PAGE_SIZE &&
        !eventsWithoutRowid &&
        eventJsonType === 'BLOB' &&
        checkpointType === 'BLOB',
    };
  } finally {
    db.close();
  }
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function tableNames(db: DatabaseSync, schema: 'main' | 'source'): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function tableColumns(db: DatabaseSync, schema: 'main' | 'source', table: string): string[] {
  return (
    db.prepare(`PRAGMA ${schema}.table_info(${quote(table)})`).all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function integrity(db: DatabaseSync, schema: 'main' | 'source'): string {
  const row = db.prepare(`PRAGMA ${schema}.integrity_check`).get() as
    | Record<string, string>
    | undefined;
  return row ? String(Object.values(row)[0]) : 'no result';
}

function assertSameTables(db: DatabaseSync): string[] {
  const source = tableNames(db, 'source');
  const target = tableNames(db, 'main');
  if (source.join('\0') !== target.join('\0'))
    throw new Error(
      `store tables differ from schema ${SCHEMA_VERSION}: source [${source.join(', ')}], target [${target.join(', ')}]`,
    );
  for (const table of source) {
    const sourceColumns = tableColumns(db, 'source', table);
    const targetColumns = tableColumns(db, 'main', table);
    if (sourceColumns.join('\0') !== targetColumns.join('\0'))
      throw new Error(
        `${table} columns differ: source [${sourceColumns.join(', ')}], target [${targetColumns.join(', ')}]`,
      );
  }
  return source;
}

function copyStore(db: DatabaseSync, sourcePath: string, optimizedAt: string): void {
  const tables = assertSameTables(db);

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of tables) {
      const columns = tableColumns(db, 'main', table);
      const list = columns.map(quote).join(', ');
      db.exec(`DELETE FROM main.${quote(table)}`);
      if (table !== 'events' && table !== 'checkpoints') {
        db.exec(
          `INSERT INTO main.${quote(table)} (${list}) SELECT ${list} FROM source.${quote(table)}`,
        );
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* Preserve the copy failure. */
    }
    throw error;
  }

  // Node keeps native values returned by a SQLite UDF alive for longer than one callback. Stream
  // from a separate read connection and bind one transformed payload at a time, committing on both
  // a row and decoded-byte ceiling. Memory is then bounded even if every record is near its limit.
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    copyEncodedTable(db, source, 'events', 'json', 2_000, 32 * 1024 * 1024);
    copyEncodedTable(db, source, 'checkpoints', 'state_json', 500, 32 * 1024 * 1024);
  } finally {
    source.close();
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    if (
      db
        .prepare(
          "SELECT 1 AS yes FROM source.sqlite_master WHERE type='table' AND name='sqlite_sequence'",
        )
        .get()
    ) {
      db.exec('DELETE FROM main.sqlite_sequence');
      db.exec(
        'INSERT INTO main.sqlite_sequence(name, seq) SELECT name, seq FROM source.sqlite_sequence',
      );
    }
    db.prepare(
      'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run('storage_layout_version', String(STORAGE_LAYOUT_VERSION));
    db.prepare(
      'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run('storage_layout_optimized_at', optimizedAt);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* Preserve the metadata copy failure. */
    }
    throw error;
  }
}

function copyEncodedTable(
  target: DatabaseSync,
  source: DatabaseSync,
  table: 'events' | 'checkpoints',
  encodedColumn: 'json' | 'state_json',
  maxRows: number,
  maxDecodedBytes: number,
): void {
  const columns = tableColumns(target, 'main', table);
  const list = columns.map(quote).join(', ');
  const first = source.prepare(
    `SELECT ${list} FROM ${quote(table)} ORDER BY session_id, seq LIMIT ?`,
  );
  const next = source.prepare(
    `SELECT ${list} FROM ${quote(table)}
      WHERE (session_id, seq) > (?, ?) ORDER BY session_id, seq LIMIT ?`,
  );
  const insert = target.prepare(
    `INSERT INTO main.${quote(table)} (${list}) VALUES (${columns.map(() => '?').join(', ')})`,
  );
  let transactionOpen = false;
  let rows = 0;
  let decodedBytes = 0;
  let cursorSession: string | undefined;
  let cursorSeq = -1;
  try {
    for (;;) {
      let pageRows = 0;
      const page =
        cursorSession === undefined
          ? first.iterate(maxRows)
          : next.iterate(cursorSession, cursorSeq, maxRows);
      for (const unknownRow of page) {
        const row = unknownRow as Record<string, string | number | bigint | null | Uint8Array>;
        if (!transactionOpen) {
          target.exec('BEGIN IMMEDIATE');
          transactionOpen = true;
        }
        const raw = row[encodedColumn];
        if (typeof raw !== 'string' && !(raw instanceof Uint8Array))
          throw new Error(`${table}.${encodedColumn} has an unsupported SQLite value type`);
        const decoded = table === 'events' ? decodeEventJsonValue(raw) : decodeCheckpointValue(raw);
        const encoded = table === 'events' ? encodeEventJson(decoded) : encodeCheckpointValue(raw);
        row[encodedColumn] = encoded;
        insert.run(...columns.map((column) => row[column] ?? null));
        rows += 1;
        pageRows += 1;
        decodedBytes += Buffer.byteLength(decoded);
        cursorSession = String(row.session_id);
        cursorSeq = Number(row.seq);
        if (rows >= maxRows || decodedBytes >= maxDecodedBytes) {
          target.exec('COMMIT');
          transactionOpen = false;
          rows = 0;
          decodedBytes = 0;
        }
      }
      if (pageRows < maxRows) break;
    }
    if (transactionOpen) {
      target.exec('COMMIT');
      transactionOpen = false;
    }
  } catch (error) {
    if (transactionOpen)
      try {
        target.exec('ROLLBACK');
      } catch {
        /* Preserve the bounded-copy failure. */
      }
    throw error;
  }
}

function logicalDigest(db: DatabaseSync, schema: 'main' | 'source'): string {
  const hash = createHash('sha256');
  const length = Buffer.allocUnsafe(8);
  const update = (value: string) => {
    // Hash accepts a string directly. Building a second full Buffer for every decoded JSON value
    // made verification memory grow with total history before V8 reclaimed the external buffers.
    length.writeBigUInt64BE(BigInt(Buffer.byteLength(value)));
    hash.update(length);
    hash.update(value, 'utf8');
  };
  digestPages(db, schema, 'events', 'session_id, seq, json', (unknownRow) => {
    const row = unknownRow as unknown as { session_id: string; seq: number; json: SqlValue };
    update(row.session_id);
    update(String(row.seq));
    update(decodeEventJsonValue(row.json));
  });
  digestPages(
    db,
    schema,
    'checkpoints',
    'session_id, seq, reducer_version, state_json',
    (unknownRow) => {
      const row = unknownRow as unknown as {
        session_id: string;
        seq: number;
        reducer_version: string;
        state_json: SqlValue;
      };
      update(row.session_id);
      update(String(row.seq));
      update(row.reducer_version);
      update(decodeCheckpointValue(row.state_json));
    },
  );
  return hash.digest('hex');
}

function digestPages(
  db: DatabaseSync,
  schema: 'main' | 'source',
  table: 'events' | 'checkpoints',
  columns: string,
  consume: (row: Record<string, unknown>) => void,
): void {
  const pageRows = 2_000;
  const first = db.prepare(
    `SELECT ${columns} FROM ${schema}.${table} ORDER BY session_id, seq LIMIT ?`,
  );
  const next = db.prepare(
    `SELECT ${columns} FROM ${schema}.${table}
      WHERE (session_id, seq) > (?, ?) ORDER BY session_id, seq LIMIT ?`,
  );
  let cursorSession: string | undefined;
  let cursorSeq = -1;
  for (;;) {
    let rows = 0;
    const page =
      cursorSession === undefined
        ? first.iterate(pageRows)
        : next.iterate(cursorSession, cursorSeq, pageRows);
    for (const row of page) {
      consume(row as Record<string, unknown>);
      cursorSession = String(row.session_id);
      cursorSeq = Number(row.seq);
      rows += 1;
    }
    if (rows < pageRows) return;
  }
}

function assertCountsMatch(db: DatabaseSync, tables: string[]): void {
  for (const table of tables) {
    // The target deliberately adds two layout provenance keys after copying the source metadata.
    if (table === 'meta') continue;
    const source = scalarNumber(db, `SELECT COUNT(*) FROM source.${quote(table)}`);
    const target = scalarNumber(db, `SELECT COUNT(*) FROM main.${quote(table)}`);
    if (source !== target) throw new Error(`${table} row count changed: ${source} to ${target}`);
  }
}

function fsyncFile(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  try {
    fsyncFile(path);
  } catch {
    // Some platforms do not permit opening a directory. The database file itself is still synced.
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!existsSync(path)) return;
    throw error;
  }
}

/**
 * Rewrites the authoritative store into a verified sibling, then atomically swaps one directory
 * entry. The source is not changed until the copy has passed counts, logical digests, and SQLite's
 * integrity check. A hard-link rollback copy remains until the replacement reopens successfully.
 */
export function optimizeStoreLayout(
  path: string,
  options: StoreOptimizationOptions = {},
): StoreOptimizationResult {
  const beforeLayout = inspectStoreLayout(path);
  const walPath = `${path}-wal`;
  const beforeBytes = statSync(path).size + (existsSync(walPath) ? statSync(walPath).size : 0);
  const requiredFreeBytes = beforeBytes + Math.max(512 * 1024 * 1024, beforeBytes * 0.1);
  const availableBytes =
    options.availableBytes ??
    (() => {
      const stats = statfsSync(dirname(path));
      return Number(stats.bavail) * Number(stats.bsize);
    })();
  if (beforeLayout.optimized)
    return {
      alreadyOptimized: true,
      beforeBytes,
      afterBytes: beforeBytes,
      requiredFreeBytes,
      eventRows: 0,
      checkpointRows: 0,
      sourceDigest: '',
      targetDigest: '',
      layout: beforeLayout,
    };
  if (beforeLayout.schemaVersion !== SCHEMA_VERSION)
    throw new Error(
      `store schema ${beforeLayout.schemaVersion ?? 'unknown'} must be upgraded to ${SCHEMA_VERSION} before optimization`,
    );
  if (availableBytes < requiredFreeBytes)
    throw new Error(
      `storage optimization needs ${requiredFreeBytes} free bytes; ${availableBytes} are available`,
    );

  const suffix = `${process.pid}-${Date.now()}`;
  const targetPath = `${path}.optimizing-${suffix}`;
  const rollbackPath = `${path}.pre-optimize-${suffix}`;
  const progress = options.onProgress ?? (() => {});
  let swapped = false;
  try {
    progress('creating optimized store');
    new SqliteStore(targetPath, { pageSize: OPTIMIZED_STORE_PAGE_SIZE }).close();
    const target = new DatabaseSync(targetPath);
    let sourceDigest = '';
    let targetDigest = '';
    let eventRows = 0;
    let checkpointRows = 0;
    try {
      target.exec(
        'PRAGMA journal_mode = DELETE; PRAGMA synchronous = OFF; PRAGMA foreign_keys = OFF; PRAGMA temp_store = FILE; PRAGMA cache_size = -32768; PRAGMA mmap_size = 0; PRAGMA threads = 1;',
      );
      target.prepare('ATTACH DATABASE ? AS source').run(path);
      target.exec('PRAGMA source.cache_size = -32768; PRAGMA source.mmap_size = 0;');
      if (integrity(target, 'source') !== 'ok')
        throw new Error('refusing to optimize a store that failed integrity_check');
      progress('copying losslessly');
      const tables = assertSameTables(target);
      copyStore(target, path, (options.now ?? new Date()).toISOString());
      target.exec('PRAGMA synchronous = FULL;');
      assertCountsMatch(target, tables);
      eventRows = scalarNumber(target, 'SELECT COUNT(*) FROM main.events');
      checkpointRows = scalarNumber(target, 'SELECT COUNT(*) FROM main.checkpoints');
      progress('verifying logical digest');
      sourceDigest = logicalDigest(target, 'source');
      targetDigest = logicalDigest(target, 'main');
      if (sourceDigest !== targetDigest)
        throw new Error(`optimized store digest changed: ${sourceDigest} to ${targetDigest}`);
      if (integrity(target, 'main') !== 'ok')
        throw new Error('optimized store failed integrity_check');
      target.exec('DETACH DATABASE source');
    } finally {
      target.close();
    }

    chmodSync(targetPath, 0o600);
    fsyncFile(targetPath);
    fsyncDirectory(dirname(path));

    // Fold any old WAL into the still-current source only after the replacement is verified. This
    // leaves a complete single-file source for the hard-link rollback and removes stale WAL state
    // before the new database takes the same pathname.
    progress('swapping verified store');
    const source = new DatabaseSync(path);
    try {
      source.exec('PRAGMA busy_timeout = 1000; BEGIN IMMEDIATE; ROLLBACK;');
      source.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;');
    } finally {
      source.close();
    }
    unlinkIfPresent(`${path}-wal`);
    unlinkIfPresent(`${path}-shm`);
    linkSync(path, rollbackPath);
    fsyncDirectory(dirname(path));
    renameSync(targetPath, path);
    swapped = true;
    fsyncDirectory(dirname(path));

    const layout = inspectStoreLayout(path);
    if (!layout.optimized) throw new Error('replacement store reopened with the wrong layout');
    new SqliteStore(path, { readOnly: true }).close();
    unlinkIfPresent(rollbackPath);
    fsyncDirectory(dirname(path));
    return {
      alreadyOptimized: false,
      beforeBytes,
      afterBytes: statSync(path).size,
      requiredFreeBytes,
      eventRows,
      checkpointRows,
      sourceDigest,
      targetDigest,
      layout,
    };
  } catch (error) {
    if (swapped && existsSync(rollbackPath)) {
      try {
        renameSync(rollbackPath, path);
        fsyncDirectory(dirname(path));
      } catch {
        // The original remains at rollbackPath for manual recovery. Preserve the first failure.
      }
    }
    unlinkIfPresent(targetPath);
    if (!swapped) unlinkIfPresent(rollbackPath);
    throw error;
  }
}
