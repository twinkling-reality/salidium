import { statSync } from 'node:fs';
import { constants, DatabaseSync, type SQLInputValue } from 'node:sqlite';

/*
 * The only way Salidium opens OpenCode's database.
 *
 * OpenCode keeps provider credentials (`credential.value`) and account tokens (`account`,
 * `control_account`) in the same SQLite file as its sessions. Not querying those tables is not
 * enough: a later change, or a mistake in a query, must not be able to read them. So the
 * connection is opened read only and an authorizer allowlists, per table, the columns this
 * adapter reads. SQLite consults the authorizer while it compiles every statement, so a statement
 * that names anything else fails to prepare with an authorization error; nothing is returned as
 * NULL. Writes, schema changes, pragmas, ATTACH, transactions and every function not listed are
 * refused the same way.
 */

/** Columns readable per table. Nothing else in the file can be read through this connection. */
const READABLE: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    'session_v2',
    new Set([
      'id',
      'parent_id',
      'fork_session_id',
      'directory',
      'title',
      'version',
      'model',
      'agent',
      'time_created',
      'time_updated',
      'time_idle',
    ]),
  ],
  [
    'session_message',
    new Set(['id', 'session_id', 'type', 'seq', 'time_created', 'time_updated', 'data']),
  ],
  ['event_sequence', new Set(['aggregate_id', 'seq'])],
]);

const READ_TABLES = [...READABLE.keys()];

/** Whether `path` is a regular file (following links), not a FIFO, socket, device or directory. */
export function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** SQL functions the queries below use. */
const CALLABLE: ReadonlySet<string> = new Set(['count', 'max', 'length']);

/** OpenCode's schema names its database `main`; nothing else may be read. */
const MAIN = 'main';

/**
 * The authorizer. Exported so tests can assert the policy directly as well as through queries.
 * `column` is the empty string when SQLite reads a table without a named column (`count(*)`,
 * `SELECT 1 FROM t`); that is allowed only for an allowlisted table, so even the number of rows
 * in a secret table cannot be learned.
 */
export function authorize(
  action: number,
  first: string | null,
  second: string | null,
  database: string | null,
): number {
  switch (action) {
    case constants.SQLITE_SELECT:
      return constants.SQLITE_OK;
    case constants.SQLITE_READ: {
      if (database !== null && database !== MAIN) return constants.SQLITE_DENY;
      const columns = first === null ? undefined : READABLE.get(first);
      if (!columns) return constants.SQLITE_DENY;
      return second === '' || (second !== null && columns.has(second))
        ? constants.SQLITE_OK
        : constants.SQLITE_DENY;
    }
    case constants.SQLITE_FUNCTION:
      return second !== null && CALLABLE.has(second.toLowerCase())
        ? constants.SQLITE_OK
        : constants.SQLITE_DENY;
    default:
      return constants.SQLITE_DENY;
  }
}

/**
 * Whether this Node.js can enforce the restriction. Without `setAuthorizer` the store is never
 * opened (opening throws), and setup surfaces say so instead of claiming the provider is read.
 */
export function restrictedReadsSupported(): boolean {
  return (
    typeof (DatabaseSync.prototype as { setAuthorizer?: unknown }).setAuthorizer === 'function'
  );
}

/** A read-only, authorizer-restricted connection to one OpenCode store. */
export class OpenCodeStoreConnection {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /**
   * Opens the store at `path` read only. Never creates, copies or migrates it. Throws when the
   * file cannot be opened or does not look like OpenCode's store; the caller treats that as
   * "store unavailable".
   */
  static open(path: string): OpenCodeStoreConnection {
    if (!restrictedReadsSupported())
      throw new Error('this Node.js cannot restrict SQLite reads (DatabaseSync.setAuthorizer)');
    // A FIFO or device at the path would block the synchronous open, and the daemon with it.
    if (!isRegularFile(path)) throw new Error('the OpenCode store is not a regular file');
    const db = new DatabaseSync(path, {
      readOnly: true,
      // A writer may hold the lock for a moment while it commits. This connection is synchronous,
      // so a long wait would stall the daemon; a store locked for longer is read on a later poll.
      timeout: 250,
      allowExtension: false,
      enableForeignKeyConstraints: false,
    });
    try {
      // Before the authorizer, the only statements this connection ever runs that it would refuse:
      // functions in views and triggers may not run, and the three tables read must be tables. A
      // view in their place could make any SELECT through this connection arbitrarily expensive.
      db.exec('PRAGMA trusted_schema = OFF');
      const kinds = new Map(
        (
          db
            .prepare(
              `SELECT name, type FROM sqlite_schema WHERE name IN (${READ_TABLES.map(() => '?').join(', ')})`,
            )
            .all(...READ_TABLES) as Array<{ name: unknown; type: unknown }>
        ).map((row) => [row.name, row.type] as const),
      );
      if (READ_TABLES.some((table) => kinds.get(table) !== 'table'))
        throw new Error('the OpenCode store does not have the expected tables');
      db.setAuthorizer((action, first, second, database) =>
        authorize(action, first, second, database),
      );
    } catch (error) {
      db.close();
      throw error;
    }
    return new OpenCodeStoreConnection(db);
  }

  /**
   * Prepares one SELECT; the authorizer checks it as it compiles. Integers come back as BigInt,
   * so a value beyond JavaScript's safe range cannot make the read throw; callers keep only safe
   * integers (see `records.ts`).
   */
  #prepare(sql: string) {
    const statement = this.#db.prepare(sql);
    statement.setReadBigInts(true);
    return statement;
  }

  all(sql: string, ...params: SQLInputValue[]): Record<string, unknown>[] {
    return this.#prepare(sql).all(...params) as Record<string, unknown>[];
  }

  iterate(sql: string, ...params: SQLInputValue[]): Iterable<Record<string, unknown>> {
    return this.#prepare(sql).iterate(...params) as Iterable<Record<string, unknown>>;
  }

  get(sql: string, ...params: SQLInputValue[]): Record<string, unknown> | undefined {
    return this.#prepare(sql).get(...params) as Record<string, unknown> | undefined;
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}

/** Opens, runs `fn`, and always closes. */
export function withOpenCodeStore<T>(path: string, fn: (store: OpenCodeStoreConnection) => T): T {
  const store = OpenCodeStoreConnection.open(path);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}
