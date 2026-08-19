import type { Epistemic, Facet, SemanticChange, StoredEvent } from '@salidium/protocol';

/** Accumulates the semantic changes produced while folding one event. */
export class ChangeLog {
  private ordinal = 0;
  readonly changes: SemanticChange[] = [];
  private readonly sessionId: string;
  private readonly event: StoredEvent;

  constructor(sessionId: string, event: StoredEvent) {
    this.sessionId = sessionId;
    this.event = event;
  }

  add(
    facet: Facet,
    summary: string,
    epistemic: Epistemic,
    detail?: Record<string, unknown>,
    refs?: string[],
  ): void {
    this.changes.push({
      sessionId: this.sessionId,
      seq: this.event.seq,
      ordinal: this.ordinal++,
      ts: this.event.ts,
      facet,
      summary: clip(summary, 160),
      epistemic,
      refs: refs ?? [this.event.id],
      ...(detail ? { detail } : {}),
    });
  }
}

export function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

export function basename(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(i + 1) : path;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
