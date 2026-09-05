import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { archiveCollectionGap, readCollectionGapLedger } from './collectionGaps.ts';

describe('collection gap ledger', () => {
  it('keeps observed loss after its active pressure marker is cleared', () => {
    const root = mkdtempSync(join(tmpdir(), 'salidium-collection-gap-'));
    try {
      const marker = join(root, 'hooks-shed-first');
      const ledger = join(root, 'collection-gaps.json');
      writeFileSync(
        marker,
        JSON.stringify({
          reason: 'pressure',
          provider: 'claude-code',
          event: 'PreToolUse',
          pressure: 'shed-first',
          firstDroppedAt: '2026-09-04T10:00:00.000Z',
          exactCount: null,
        }),
      );

      archiveCollectionGap(marker, ledger, '2026-09-04T10:01:00.000Z');

      expect(readCollectionGapLedger(ledger)).toEqual({
        version: 1,
        omittedEpisodes: 0,
        episodes: [
          {
            reason: 'pressure',
            provider: 'claude-code',
            event: 'PreToolUse',
            pressure: 'shed-first',
            firstDroppedAt: '2026-09-04T10:00:00.000Z',
            recoveredAt: '2026-09-04T10:01:00.000Z',
            exactCount: null,
          },
        ],
      });
      expect(() => readFileSync(marker)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds retained episodes while preserving an exact omitted episode count', () => {
    const root = mkdtempSync(join(tmpdir(), 'salidium-collection-gap-bound-'));
    try {
      const marker = join(root, 'marker');
      const ledger = join(root, 'collection-gaps.json');
      for (let index = 0; index < 105; index++) {
        writeFileSync(marker, JSON.stringify({ reason: `pressure-${index}`, exactCount: null }));
        archiveCollectionGap(
          marker,
          ledger,
          `2026-09-04T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
        );
      }

      const value = readCollectionGapLedger(ledger);
      expect(value.episodes).toHaveLength(100);
      expect(value.omittedEpisodes).toBe(5);
      expect(value.episodes[0]?.reason).toBe('pressure-5');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
