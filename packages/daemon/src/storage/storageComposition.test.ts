import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionSummary, StoredEvent } from '@salidium/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStore } from './sqliteStore.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temporaryStore() {
  const dir = mkdtempSync(join(tmpdir(), 'salidium-composition-'));
  dirs.push(dir);
  return new SqliteStore(join(dir, 'store.db'));
}

function summary(id: string, repoRoot: string | undefined, cwd = ''): SessionSummary {
  const at = '2020-01-01T00:00:00.000Z';
  return {
    id,
    provider: 'codex',
    providerSessionId: id.slice(id.indexOf(':') + 1),
    cwd,
    ...(repoRoot ? { repoRoot } : {}),
    title: id,
    status: 'ended',
    startedAt: at,
    lastEventAt: at,
    endedAt: at,
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
  };
}

function message(sessionId: string, seq: number, text: string): StoredEvent {
  return {
    id: `${sessionId}#${seq}`,
    sessionId,
    seq,
    ts: '2020-01-01T00:00:00.000Z',
    tsSource: 'provider',
    source: { provider: 'codex', channel: 'rollout' },
    kind: 'agent.message',
    text,
  };
}

describe('what the store is made of', () => {
  /*
   * The parts have to add up to the file, because the whole point of the view they feed is a bar
   * whose segments fill it. `structure` is a subtraction, so this is also the assertion that keeps
   * the subtraction honest when a named part is added or changed.
   */
  it('accounts for the whole file, with structure as the remainder', () => {
    const store = temporaryStore();
    try {
      store.upsertSession(summary('codex:one', '/repo/alpha'));
      store.insertEvents([message('codex:one', 0, 'x'.repeat(4000))]);
      const measured = store.storageComposition();

      expect(measured.state).toBe('ready');
      expect(measured.fileBytes).toBeGreaterThan(0);
      const summed = measured.parts.reduce((total, part) => total + part.bytes, 0);
      expect(summed).toBe(measured.fileBytes);
      expect(measured.parts.map((part) => part.key)).toEqual([
        'sessions',
        'checkpoints',
        'provenance',
        'structure',
        'reusable',
      ]);
    } finally {
      store.close();
    }
  });

  it('attributes bytes to the repository root, and falls back to the working directory', () => {
    const store = temporaryStore();
    try {
      store.upsertSession(summary('codex:one', '/repo/alpha', '/repo/alpha/packages/ui'));
      store.upsertSession(summary('codex:two', undefined, '/repo/beta'));
      store.insertEvents([message('codex:one', 0, 'a'.repeat(8000))]);
      store.insertEvents([message('codex:two', 0, 'b'.repeat(1000))]);

      const measured = store.storageComposition();
      const paths = measured.projects.map((project) => project.path);
      expect(paths).toContain('/repo/alpha');
      expect(paths).toContain('/repo/beta');
      // Ranked by bytes, and the larger session is the one with the larger event.
      expect(measured.projects[0]?.path).toBe('/repo/alpha');
      expect(measured.projects[0]?.bytes).toBeGreaterThan(measured.projects[1]?.bytes ?? 0);
      expect(measured.sessions).toBe(2);
    } finally {
      store.close();
    }
  });

  /*
   * A session that recorded neither a repository nor a working directory is a real case, and it
   * has to be one row a reader can see rather than bytes quietly missing from every total.
   */
  it('keeps sessions with no project as their own group', () => {
    const store = temporaryStore();
    try {
      store.upsertSession(summary('codex:nowhere', undefined));
      store.insertEvents([message('codex:nowhere', 0, 'c'.repeat(2000))]);
      const measured = store.storageComposition();
      expect(measured.projects.map((project) => project.path)).toEqual(['']);
      expect(measured.projects[0]?.sessions).toBe(1);
    } finally {
      store.close();
    }
  });

  it('says how many projects it did not list rather than implying the list is all of them', () => {
    const store = temporaryStore();
    try {
      for (let index = 0; index < 5; index += 1) {
        const id = `codex:s${index}`;
        store.upsertSession(summary(id, `/repo/p${index}`));
        store.insertEvents([message(id, 0, 'd'.repeat(1000 * (index + 1)))]);
      }
      const measured = store.storageComposition(2);
      expect(measured.projects).toHaveLength(2);
      expect(measured.projectsOmitted).toBe(3);
      // The two listed are the two largest, so a truncated list is still the useful end of it.
      expect(measured.projects[0]?.path).toBe('/repo/p4');
      expect(measured.projects[1]?.path).toBe('/repo/p3');
    } finally {
      store.close();
    }
  });
});
