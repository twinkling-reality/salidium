import { DatabaseSync } from 'node:sqlite';
import { OPENCODE_2_0_18_SCHEMA } from './schema.ts';

/*
 * Builds synthetic OpenCode 2.0.18 stores for tests: the real schema, invented content. Record
 * shapes follow what the pinned binary was observed to write (see the adapter's records notes):
 * `data` is the message JSON without `id` and `type`, an assistant step carries its tool calls
 * and results, and `event_sequence` holds each session's last durable sequence.
 *
 * This is the only code in the package that writes SQLite, and it writes only files a test made.
 */

export const T0 = Date.UTC(2026, 9, 2, 12, 0, 0);

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter.toString(36).padStart(6, '0')}SYNTHETIC${counter.toString(36)}`;
}

export interface SyntheticSession {
  id?: string;
  projectId?: string;
  parentId?: string;
  forkSessionId?: string;
  directory: string;
  title?: string;
  agent?: string;
  model?: { providerID: string; id: string };
  timeCreated?: number;
}

export class SyntheticOpenCodeStore {
  readonly path: string;
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.path = path;
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL');
    for (const statement of OPENCODE_2_0_18_SCHEMA) this.#db.exec(statement);
    // Secrets a reader must never reach. Values are obviously fake.
    this.#db
      .prepare(
        'INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run('cred_synthetic', 'ollama', 'synthetic', 'sk-synthetic-credential-value', 1, T0, T0);
    this.#db
      .prepare(
        'INSERT INTO account (id, email, url, access_token, refresh_token, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        'acc_synthetic',
        'person@example.invalid',
        'https://example.invalid',
        'synthetic-access',
        'synthetic-refresh',
        T0,
        T0,
      );
    this.#db
      .prepare(
        'INSERT INTO control_account (email, url, access_token, refresh_token, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        'person@example.invalid',
        'https://example.invalid',
        'synthetic-control-access',
        'synthetic-control-refresh',
        1,
        T0,
        T0,
      );
  }

  session(spec: SyntheticSession): string {
    const id = spec.id ?? nextId('ses');
    const projectId = spec.projectId ?? 'synthetic0project0root0commit000000000000';
    const created = spec.timeCreated ?? T0;
    this.#db
      .prepare(
        'INSERT OR IGNORE INTO project (id, worktree, vcs, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(projectId, spec.directory, 'git', created, created, '[]');
    this.#db
      .prepare(
        `INSERT INTO session_v2 (id, project_id, parent_id, fork_session_id, slug, directory, title, version, model, agent, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        projectId,
        spec.parentId ?? null,
        spec.forkSessionId ?? null,
        'quiet-synthetic',
        spec.directory,
        spec.title ?? null,
        '2.0.18',
        JSON.stringify(spec.model ?? { id: 'qwen-synthetic', providerID: 'ollama' }),
        spec.agent ?? null,
        created,
        created,
      );
    this.#db.prepare('INSERT INTO event_sequence (aggregate_id, seq) VALUES (?, ?)').run(id, 0);
    return id;
  }

  /** Appends a message at the next durable sequence (or `seq`), as OpenCode projects one. */
  message(
    sessionId: string,
    type: string,
    data: Record<string, unknown>,
    options: { id?: string; seq?: number; gap?: number } = {},
  ): { id: string; seq: number } {
    const current = this.sequence(sessionId);
    const seq = options.seq ?? current + 1 + (options.gap ?? 0);
    const id = options.id ?? nextId('msg');
    const time = (data.time as { created?: number } | undefined)?.created ?? T0;
    this.#db
      .prepare(
        'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, sessionId, type, seq, time, time, JSON.stringify(data));
    this.setSequence(sessionId, Math.max(current, seq));
    return { id, seq };
  }

  /** Rewrites a row in place, as OpenCode does while a step streams, and advances the sequence. */
  update(sessionId: string, id: string, data: Record<string, unknown>): void {
    this.#db
      .prepare('UPDATE session_message SET data = ?, time_updated = time_updated + 1 WHERE id = ?')
      .run(JSON.stringify(data), id);
    this.setSequence(sessionId, this.sequence(sessionId) + 1);
  }

  /** OpenCode's revert commit: deletes every row from `fromSeq` on and advances the sequence. */
  revert(sessionId: string, fromSeq: number): void {
    this.#db
      .prepare('DELETE FROM session_message WHERE session_id = ? AND seq >= ?')
      .run(sessionId, fromSeq);
    this.setSequence(sessionId, this.sequence(sessionId) + 2);
  }

  setTitle(sessionId: string, title: string, at: number): void {
    this.#db
      .prepare('UPDATE session_v2 SET title = ?, time_updated = ? WHERE id = ?')
      .run(title, at, sessionId);
  }

  setIdle(sessionId: string, at: number): void {
    this.#db
      .prepare("UPDATE session_v2 SET time_idle = ?, idle_outcome = 'succeeded' WHERE id = ?")
      .run(at, sessionId);
  }

  /** Copies rows the way OpenCode's fork does: new ids `<id>_<seq>`, same sequence numbers. */
  fork(sourceId: string, spec: SyntheticSession): string {
    const id = this.session({ ...spec, forkSessionId: sourceId });
    const rows = this.#db
      .prepare(
        'SELECT type, seq, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq',
      )
      .all(sourceId) as Array<{ type: string; seq: number; time_created: number; data: string }>;
    const base = nextId('msg');
    for (const row of rows) {
      this.#db
        .prepare(
          'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          `${base}_${row.seq}`,
          id,
          row.type,
          row.seq,
          row.time_created,
          row.time_created,
          row.data,
        );
    }
    this.setSequence(id, this.sequence(sourceId));
    return id;
  }

  /** Runs arbitrary SQL against the synthetic file, for hostile and malformed cases. */
  exec(sql: string, ...params: Array<string | number | bigint | null>): void {
    this.#db.prepare(sql).run(...params);
  }

  sequence(sessionId: string): number {
    const row = this.#db
      .prepare('SELECT seq FROM event_sequence WHERE aggregate_id = ?')
      .get(sessionId) as { seq: number } | undefined;
    return row?.seq ?? 0;
  }

  private setSequence(sessionId: string, seq: number): void {
    this.#db
      .prepare(
        'INSERT INTO event_sequence (aggregate_id, seq) VALUES (?, ?) ON CONFLICT(aggregate_id) DO UPDATE SET seq = excluded.seq',
      )
      .run(sessionId, seq);
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}

// Record builders, shaped like OpenCode 2.0.18's projections.

export function userData(text: string, at: number): Record<string, unknown> {
  return { time: { created: at }, text };
}

export function idleData(outcome: 'succeeded' | 'failed' | 'interrupted', at: number) {
  return { time: { created: at }, outcome };
}

export interface ToolPart {
  type: 'tool';
  id: string;
  name: string;
  /** Every 2.x part has it; a part migrated from 1.x does not. */
  executed?: boolean;
  state: Record<string, unknown>;
  time: { created: number; ran?: number; completed?: number };
}

export function stepData(
  at: number,
  parts: Array<ToolPart | { type: 'text'; text: string } | { type: 'reasoning'; text: string }>,
  options: {
    finish?: 'stop' | 'tool-calls' | 'error';
    running?: boolean;
    tokens?: { input: number; output: number; cacheRead?: number };
    model?: string;
    error?: { type: string; message: string };
  } = {},
): Record<string, unknown> {
  const done = !options.running;
  const tokens = options.tokens ?? { input: 120, output: 30, cacheRead: 0 };
  return {
    time: done ? { created: at, streamed: at + 900, completed: at + 1000 } : { created: at },
    agent: 'build',
    model: { id: options.model ?? 'qwen-synthetic', providerID: 'ollama', variant: 'default' },
    content: parts.map((part) =>
      part.type === 'reasoning'
        ? {
            ...part,
            state: { reasoningField: 'reasoning' },
            time: { created: at, completed: at + 10 },
          }
        : part,
    ),
    snapshot: { start: 'a'.repeat(40), end: 'b'.repeat(40), files: [] },
    ...(done
      ? {
          finish: options.finish ?? 'stop',
          rawFinish: options.finish === 'tool-calls' ? 'tool_calls' : (options.finish ?? 'stop'),
          cost: 0,
          tokens: {
            input: tokens.input,
            output: tokens.output,
            reasoning: 0,
            cache: { read: tokens.cacheRead ?? 0, write: 0 },
          },
        }
      : {}),
    ...(options.error ? { error: options.error } : {}),
  };
}

function completed(
  name: string,
  callId: string,
  at: number,
  input: Record<string, unknown>,
  text: string,
  metadata: Record<string, unknown>,
): ToolPart {
  return {
    type: 'tool',
    id: callId,
    name,
    executed: false,
    state: { status: 'completed', input, content: [{ type: 'text', text }], metadata },
    time: { created: at, ran: at + 5, completed: at + 50 },
  };
}

export const tools = {
  shell(callId: string, at: number, command: string, exit: number, output: string): ToolPart {
    return completed('shell', callId, at, { command, timeout: 15000 }, output, {
      status: 'completed',
      truncated: false,
      exit,
    });
  },
  read(callId: string, at: number, path: string, body = '1: synthetic line'): ToolPart {
    return completed('read', callId, at, { path }, `Read file ${path}, lines 1-1\n${body}`, {
      truncated: false,
    });
  },
  listDirectory(callId: string, at: number, path: string): ToolPart {
    return completed(
      'read',
      callId,
      at,
      { path },
      `Read directory ${path}, entries 1-2\na.js\nb.js`,
      {
        truncated: false,
      },
    );
  },
  grep(callId: string, at: number, pattern: string, path: string): ToolPart {
    return completed('grep', callId, at, { pattern, path }, 'Found 1 matches', {
      matches: 1,
      truncated: false,
    });
  },
  glob(callId: string, at: number, pattern: string, path: string): ToolPart {
    return completed('glob', callId, at, { pattern, path }, `${path}/a.js`, {
      count: 1,
      truncated: false,
    });
  },
  edit(callId: string, at: number, absolute: string, relative: string): ToolPart {
    const patch = `Index: ${relative}\n===================================================================\n--- ${relative}\n+++ ${relative}\n@@ -1,3 +1,3 @@\n export function add(a, b) {\n-  return a - b;\n+  return a + b;\n }\n`;
    return completed(
      'edit',
      callId,
      at,
      { path: absolute, oldString: '  return a - b;', newString: '  return a + b;' },
      `Edited ${relative} (1 replacement)`,
      {
        files: [{ file: relative, patch, status: 'modified', additions: 1, deletions: 1 }],
        truncated: false,
      },
    );
  },
  write(
    callId: string,
    at: number,
    absolute: string,
    relative: string,
    content: string,
    created: boolean,
  ): ToolPart {
    return completed(
      'write',
      callId,
      at,
      { path: absolute, content },
      `${created ? 'Created' : 'Wrote'} file successfully: ${relative}`,
      { truncated: false },
    );
  },
  patch(callId: string, at: number): ToolPart {
    return completed(
      'patch',
      callId,
      at,
      {
        patchText:
          '*** Begin Patch\n*** Update File: README.md\n@@\n+more\n*** Add File: notes.txt\n+patched\n*** Delete File: old.js\n*** End Patch',
      },
      'Success. Updated the following files:\nM README.md\nA notes.txt\nD old.js',
      {
        files: [
          {
            file: 'README.md',
            patch: '@@ -1,1 +1,2 @@\n # Title\n+more\n',
            status: 'modified',
            additions: 1,
            deletions: 0,
          },
          {
            file: 'notes.txt',
            patch: '@@ -0,0 +1,1 @@\n+patched\n',
            status: 'added',
            additions: 1,
            deletions: 0,
          },
          {
            file: 'old.js',
            patch: '@@ -1,3 +0,0 @@\n-a\n-b\n-c\n',
            status: 'deleted',
            additions: 0,
            deletions: 3,
          },
        ],
        truncated: false,
      },
    );
  },
  subagent(callId: string, at: number, childSessionId: string, answer: string): ToolPart {
    return completed(
      'subagent',
      callId,
      at,
      { agent: 'explore', description: 'Find synthetic files', prompt: 'Find the files.' },
      `<subagent sessionID="${childSessionId}" state="completed">\n${answer}\n</subagent>`,
      { sessionID: childSessionId, status: 'completed', truncated: false },
    );
  },
  /** A 1.x `todowrite` part as OpenCode's migration carries it over: no `executed` field. */
  todowrite(callId: string, at: number): ToolPart {
    const { executed: _executed, ...migrated } = completed(
      'todowrite',
      callId,
      at,
      {
        todos: [
          { id: '1', content: 'Fix add', status: 'completed', priority: 'high' },
          { id: '2', content: 'Run tests', status: 'in_progress', priority: 'medium' },
        ],
      },
      '2 todos',
      {},
    );
    return migrated;
  },
  failed(
    callId: string,
    at: number,
    name: string,
    input: Record<string, unknown>,
    error: { type: string; message: string },
  ): ToolPart {
    return {
      type: 'tool',
      id: callId,
      name,
      executed: false,
      state: { status: 'error', input, error },
      time: { created: at, ran: at + 5, completed: at + 60 },
    };
  },
  running(callId: string, at: number, name: string, input: Record<string, unknown>): ToolPart {
    return {
      type: 'tool',
      id: callId,
      name,
      executed: false,
      state: { status: 'running', input },
      time: { created: at, ran: at + 5 },
    };
  },
};
