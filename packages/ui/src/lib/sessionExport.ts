import type { SessionView } from '@salidium/core';

export interface SessionExportIdentity {
  id: string;
  provider: string;
  title: string;
  cwd: string;
  model?: string;
}

/** A portable report export contains the projection, never provider transcript records. */
export function sessionExport(
  session: SessionExportIdentity,
  report: SessionView,
  exportedAt = new Date().toISOString(),
) {
  return {
    format: 'salidium.session-report' as const,
    version: 1 as const,
    exportedAt,
    session,
    report,
  };
}

export function sessionExportFilename(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 64);
  return `salidium-${slug || 'session'}.json`;
}

export function downloadSessionExport(session: SessionExportIdentity, report: SessionView): void {
  const blob = new Blob([`${JSON.stringify(sessionExport(session, report), null, 2)}\n`], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = sessionExportFilename(session.title);
  anchor.click();
  URL.revokeObjectURL(url);
}
