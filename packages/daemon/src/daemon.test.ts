import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildSyntheticTranscript } from '@salidium/adapter-claude-code/testing';
import type { SessionSnapshot, SessionSummary } from '@salidium/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DaemonHandle, startDaemon } from './daemon.ts';
import { SqliteStore } from './storage/sqliteStore.ts';

const tmp = mkdtempSync(join(tmpdir(), 'salidium-test-'));
const userHome = join(tmp, 'home');
const salidiumHome = join(tmp, 'salidium');
const { sessionId: pid, lines } = buildSyntheticTranscript({ cwd: join(userHome, 'repo') });
const projectDir = join(userHome, '.claude', 'projects', '-home-repo');
const transcriptPath = join(projectDir, `${pid}.jsonl`);
let daemon: DaemonHandle;

async function api<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting');
    await sleep(50);
  }
}

beforeAll(async () => {
  mkdirSync(projectDir, { recursive: true });
  // Write the transcript except the last few records; the rest is appended live later.
  writeFileSync(transcriptPath, `${lines.slice(0, 12).join('\n')}\n`);
  daemon = await startDaemon({
    home: salidiumHome,
    userHome,
    port: 0,
    providers: ['claude-code'],
    gitEnrichment: false,
    historyDays: 30,
    logLevel: 'silent',
  });
});

afterAll(async () => {
  await daemon.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe('daemon', () => {
  it('does not create a retention sweep under the default Forever policy', async () => {
    const home = join(tmp, 'retention-forever');
    const seeded = new SqliteStore(join(home, 'salidium.db'));
    seeded.upsertSession({
      id: 'codex:kept-by-default',
      provider: 'codex',
      providerSessionId: 'kept-by-default',
      cwd: '/repo',
      status: 'ended',
      startedAt: '2020-01-01T00:00:00.000Z',
      lastEventAt: '2020-01-01T00:00:00.000Z',
      endedAt: '2020-01-01T00:00:00.000Z',
      latestSeq: 0,
      counts: {
        turns: 0,
        toolCalls: 0,
        filesChanged: 0,
        linesAdded: 0,
        linesRemoved: 0,
        reviewOpen: 0,
        remaining: 0,
      },
    });
    seeded.close();
    const retained = await startDaemon({
      home,
      userHome,
      port: 0,
      providers: [],
      gitEnrichment: false,
      historyDays: 0,
      logLevel: 'silent',
      retentionSweepIntervalMs: 10,
    });
    try {
      await sleep(60);
      expect(retained.registry.listSessions().map((session) => session.id)).toContain(
        'codex:kept-by-default',
      );
    } finally {
      await retained.stop();
    }
  });

  it('applies an opted-in retention policy after startup discovery', async () => {
    const home = join(tmp, 'retention-startup');
    mkdirSync(home, { recursive: true });
    const db = join(home, 'salidium.db');
    const expired = 'codex:expired-at-start';
    const seeded = new SqliteStore(db);
    seeded.upsertSession({
      id: expired,
      provider: 'codex',
      providerSessionId: 'expired-at-start',
      cwd: '/repo',
      status: 'ended',
      startedAt: '2020-01-01T00:00:00.000Z',
      lastEventAt: '2020-01-01T00:00:00.000Z',
      endedAt: '2020-01-01T00:00:00.000Z',
      latestSeq: -1,
      counts: {
        turns: 0,
        toolCalls: 0,
        filesChanged: 0,
        linesAdded: 0,
        linesRemoved: 0,
        reviewOpen: 0,
        remaining: 0,
      },
    });
    seeded.setRetentionPolicy(30);
    seeded.close();

    const retained = await startDaemon({
      home,
      userHome,
      port: 0,
      providers: [],
      gitEnrichment: false,
      historyDays: 0,
      logLevel: 'silent',
      retentionSweepIntervalMs: 10,
    });
    try {
      await waitFor(async () =>
        retained.registry.listSessions().some((session) => session.id === expired)
          ? undefined
          : true,
      );
      expect(retained.registry.snapshot(expired)).toBeUndefined();
    } finally {
      await retained.stop();
    }

    const reopened = new SqliteStore(db, { readOnly: true });
    try {
      expect(reopened.getSession(expired)).toBeUndefined();
      expect(reopened.isSessionTombstoned(expired)).toBe(true);
    } finally {
      reopened.close();
    }
  });

  it('stops promptly while a browser-style event stream is open', async () => {
    const streamHome = join(tmp, 'stream-stop');
    const streamed = await startDaemon({
      home: streamHome,
      userHome,
      port: 0,
      providers: [],
      gitEnrichment: false,
      historyDays: 0,
      logLevel: 'silent',
    });
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${streamed.port}/api/stream`, {
      headers: { Authorization: `Bearer ${streamed.token}` },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);

    const outcome = await Promise.race([
      streamed.stop().then(() => 'stopped'),
      sleep(1_000).then(() => 'timed out'),
    ]);
    controller.abort();
    expect(outcome).toBe('stopped');
  });

  it('rejects unauthenticated, wrong-host and cross-origin requests', async () => {
    const base = `http://127.0.0.1:${daemon.port}`;
    expect((await fetch(`${base}/api/sessions`)).status).toBe(401);
    // fetch() refuses to override Host; use node:http to simulate a DNS-rebinding request.
    const hostStatus = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: daemon.port,
          path: '/api/sessions',
          headers: { Authorization: `Bearer ${daemon.token}`, Host: 'evil.example:80' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(hostStatus).toBe(421);
    expect(
      (
        await fetch(`${base}/api/sessions`, {
          headers: { Authorization: `Bearer ${daemon.token}`, Origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${base}/api/sessions`, {
          headers: {
            Authorization: `Bearer ${daemon.token}`,
            Origin: `http://127.0.0.1:${daemon.port}`,
          },
        })
      ).status,
    ).toBe(200);
  });

  it('backfills the transcript found on disk, then follows appends and hook payloads', async () => {
    const sessions = await waitFor(async () => {
      const r = await api<SessionSummary[]>('/api/sessions');
      return r.body.length ? r.body : undefined;
    });
    expect(sessions[0]?.id).toBe(`claude-code:${pid}`);
    const sid = encodeURIComponent(sessions[0]?.id ?? '');
    let snap = (await api<SessionSnapshot>(`/api/sessions/${sid}/snapshot`)).body;
    expect(snap.summary.counts.filesChanged).toBe(1);
    // Append the remaining records live; the tailer should pick them up.
    appendFileSync(transcriptPath, `${lines.slice(12).join('\n')}\n`);
    snap = await waitFor(async () => {
      const s = (await api<SessionSnapshot>(`/api/sessions/${sid}/snapshot`)).body;
      return s.summary.counts.filesChanged === 2 && s.summary.counts.turns === 2 ? s : undefined;
    });
    expect(snap.summary.lastVerification?.outcome).toBe('pass');
    expect(snap.changes.some((c) => c.summary.includes('45/45 tests passed'))).toBe(true);
    // A hook payload for a tool call the transcript already recorded is retained as separate raw
    // evidence, but lower fidelity must not change the transcript-derived projection.
    const before = snap.seq;
    const beforeCounts = snap.summary.counts;
    const post = await api<undefined>('/hooks/claude-code', {
      method: 'POST',
      body: JSON.stringify({
        session_id: pid,
        hook_event_name: 'PostToolUse',
        prompt_id: 'aaaaaaaa-0000-4000-8000-000000000001',
        tool_name: 'Edit',
        tool_use_id: 'toolu_01BBBB',
        tool_input: {},
        tool_response: { filePath: '/x', structuredPatch: [] },
        transcript_path: transcriptPath,
        cwd: join(userHome, 'repo'),
      }),
    });
    expect(post.status).toBe(204);
    const after = (await api<SessionSnapshot>(`/api/sessions/${sid}/snapshot`)).body;
    expect(after.seq).toBe(before + 1);
    expect(after.summary.counts).toEqual(beforeCounts);
    // A genuinely new hook event is accepted.
    await api('/hooks/claude-code', {
      method: 'POST',
      body: JSON.stringify({
        session_id: pid,
        hook_event_name: 'PermissionRequest',
        prompt_id: 'aaaaaaaa-0000-4000-8000-000000000002',
        tool_name: 'Bash',
        tool_input: { command: 'git push origin main' },
        transcript_path: transcriptPath,
        cwd: join(userHome, 'repo'),
      }),
    });
    const waiting = await waitFor(async () => {
      const s = (await api<SessionSnapshot>(`/api/sessions/${sid}/snapshot`)).body;
      return s.summary.status === 'waiting' ? s : undefined;
    });
    expect(waiting.summary.counts.reviewOpen).toBeGreaterThan(0);
  });

  it('serves point-in-time state, raw records and streams', async () => {
    const sid = encodeURIComponent(`claude-code:${pid}`);
    const snap = (await api<SessionSnapshot>(`/api/sessions/${sid}/snapshot`)).body;
    const firstTurnEnd = snap.changes.find((c) => c.summary.startsWith('Turn complete'));
    expect(firstTurnEnd).toBeDefined();
    const at = (
      await api<{ state: { turns: unknown[]; counters: { filesChanged: number } }; seq: number }>(
        `/api/sessions/${sid}/state?at=${firstTurnEnd?.seq}`,
      )
    ).body;
    expect(at.state.turns).toHaveLength(1);
    expect(at.seq).toBe(firstTurnEnd?.seq);
    const view = (
      await api<{ verdict: { headline: string }; now: { what: unknown[] } }>(
        `/api/sessions/${sid}/view?at=${firstTurnEnd?.seq}`,
      )
    ).body;
    expect(view.verdict.headline).toBeTruthy();
    const events = (
      await api<Array<{ id: string; kind: string }>>(`/api/sessions/${sid}/events?after=-1&limit=5`)
    ).body;
    expect(events).toHaveLength(5);
    const editEvent = (
      await api<Array<{ id: string; kind: string }>>(
        `/api/sessions/${sid}/events?after=-1&limit=200`,
      )
    ).body.find((e) => e.kind === 'tool.completed');
    const raw = (
      await api<{ raw: { type: string } | null }>(
        `/api/sessions/${sid}/raw/${encodeURIComponent(editEvent?.id ?? '')}`,
      )
    ).body;
    expect(raw.raw?.type).toBe('user');
    // Stream: first message replays from `after`.
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/sessions/${sid}/stream?after=-1`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
      signal: controller.signal,
    });
    const reader = res.body?.getReader();
    const chunk = await reader?.read();
    expect(new TextDecoder().decode(chunk?.value)).toContain('"type":"event"');
    controller.abort();
  });

  it('survives a restart with state and history intact, and drains a spool', async () => {
    const sid = `claude-code:${pid}`;
    const before = (await api<SessionSnapshot>(`/api/sessions/${encodeURIComponent(sid)}/snapshot`))
      .body;
    await daemon.stop();
    // Simulate a hook that fired while the daemon was down.
    mkdirSync(join(salidiumHome, 'spool'), { recursive: true });
    writeFileSync(
      join(salidiumHome, 'spool', 'claude-code.20260816.jsonl'),
      `${JSON.stringify({ provider: 'claude-code', receivedAt: new Date().toISOString(), payload: { session_id: pid, hook_event_name: 'SessionEnd', reason: 'other', transcript_path: transcriptPath, cwd: join(userHome, 'repo') } })}\n`,
    );
    daemon = await startDaemon({
      home: salidiumHome,
      userHome,
      port: 0,
      providers: ['claude-code'],
      gitEnrichment: false,
      historyDays: 30,
      logLevel: 'silent',
    });
    const after = await waitFor(async () => {
      const s = (await api<SessionSnapshot>(`/api/sessions/${encodeURIComponent(sid)}/snapshot`))
        .body;
      return s.summary.status === 'ended' ? s : undefined;
    });
    expect(after.summary.counts).toEqual(before.summary.counts);
    expect(after.seq).toBe(before.seq + 1);
    const allChanges = (
      await api<Array<{ facet: string; summary: string }>>(
        `/api/sessions/${encodeURIComponent(sid)}/changes?after=-1`,
      )
    ).body;
    expect(allChanges.map((c) => c.summary)).toContain('Session ended');
    expect(allChanges.map((c) => c.summary)).toContain('Changed SessionManager.ts (+2 −1)');
  });
});
