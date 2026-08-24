import { describe, expect, it } from 'vitest';
import { sessionExport, sessionExportFilename } from './sessionExport.ts';

describe('session report export', () => {
  it('is versioned and names the projection rather than raw provider records', () => {
    const report = { verdict: { headline: 'Needs review' } } as never;
    expect(
      sessionExport(
        { id: 'codex:1', provider: 'codex', title: 'Fix checkout', cwd: '/repo' },
        report,
        '2026-08-23T12:00:00.000Z',
      ),
    ).toEqual({
      format: 'salidium.session-report',
      version: 1,
      exportedAt: '2026-08-23T12:00:00.000Z',
      session: {
        id: 'codex:1',
        provider: 'codex',
        title: 'Fix checkout',
        cwd: '/repo',
      },
      report,
    });
  });

  it('makes a stable, safe filename', () => {
    expect(sessionExportFilename('Fix checkout / retry!')).toBe('salidium-fix-checkout-retry.json');
    expect(sessionExportFilename('🔥')).toBe('salidium-session.json');
  });
});
