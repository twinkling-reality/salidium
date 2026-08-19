import { CLAIM_THRESHOLD, type ExtractedClaim, extractClaims } from '@salidium/core';

/**
 * `salidium audit-claims` — measure the claims layer against a real store.
 *
 * This exists because of how the confidence model was arrived at. The rules it replaced were
 * keyword matches with no threshold, and the only way to evaluate them was to run them over a
 * representative corpus and inspect what came back. That measurement decided the design, and it
 * was initially a throwaway script.
 *
 * A throwaway script is the wrong home for it, for two reasons:
 *
 * 1. **Every rule change needs re-measuring.** A lexical rule that looks obviously right is how
 *    the old ones were written. The distribution, not the reading, is the evidence.
 * 2. **No single corpus proves generality.** The rules are lead-anchored rather than
 *    keyword-anywhere, which should travel better than what they replaced, but each user running
 *    this against their own store is the real test, and it has to be one command.
 *
 * It reads the store through the daemon's own API, so it sees exactly what the app sees, and it
 * asserts nothing about quality on its own: precision is a judgement, so the command's job is to
 * put a reproducible random sample of each rule's output in front of a person.
 */

export interface AuditOptions {
  /** How many sampled claims to print per rule. 0 prints none. */
  sample: number;
  /** Only print samples for these rules (substring match). Empty means all. */
  only: string[];
  /** Reproducible sampling. The same seed over the same store gives the same sample. */
  seed: number;
  /** Cap on sessions read, newest first. */
  limit: number;
  json: boolean;
}

export interface AuditMessage {
  text: string;
  phase: 'commentary' | 'final';
}

export interface AuditResult {
  sessions: number;
  messages: number;
  /** Messages that produced no claim at all: not narration (a header, a fence, an artifact). */
  silentMessages: number;
  claims: number;
  asserted: number;
  byKind: Record<string, number>;
  byRule: Record<string, number>;
  /** Claims still carrying a markdown marker after flattening. */
  markdownLeaks: number;
  samples: Record<string, string[]>;
}

const MARKDOWN_MARKER = /`|\*\*|^#{1,6}\s|```|\]\(/;

/** Deterministic, seeded, and deliberately not `Math.random`: an audit has to be re-runnable. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

export function auditClaims(
  sessions: Iterable<{ messages: AuditMessage[] }>,
  opts: AuditOptions,
): AuditResult {
  const byKind: Record<string, number> = {};
  const byRule: Record<string, number> = {};
  const pool = new Map<string, string[]>();
  let sessionCount = 0;
  let messages = 0;
  let silentMessages = 0;
  let claims = 0;
  let asserted = 0;
  let markdownLeaks = 0;

  for (const s of sessions) {
    sessionCount++;
    for (const m of s.messages) {
      messages++;
      const out: ExtractedClaim[] = extractClaims(m.text, m.phase);
      if (out.length === 0) {
        silentMessages++;
        continue;
      }
      for (const c of out) {
        claims++;
        if (c.confidence >= CLAIM_THRESHOLD && c.kind !== 'other') asserted++;
        byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
        const rule = `${c.kind}/${c.rule}`;
        byRule[rule] = (byRule[rule] ?? 0) + 1;
        if (MARKDOWN_MARKER.test(c.text)) markdownLeaks++;
        const arr = pool.get(rule) ?? [];
        arr.push(c.text);
        pool.set(rule, arr);
      }
    }
  }

  const samples: Record<string, string[]> = {};
  if (opts.sample > 0) {
    const rand = rng(opts.seed);
    for (const [rule, arr] of [...pool].sort()) {
      if (opts.only.length > 0 && !opts.only.some((o) => rule.includes(o))) continue;
      const want = Math.min(opts.sample, arr.length);
      // Reservoir over a shuffled index set: with fewer claims than asked for, take them all.
      const idx = new Set<number>();
      let guard = 0;
      while (idx.size < want && guard++ < want * 40) idx.add(Math.floor(rand() * arr.length));
      samples[rule] = [...idx].map((i) => arr[i] as string);
    }
  }
  return {
    sessions: sessionCount,
    messages,
    silentMessages,
    claims,
    asserted,
    byKind,
    byRule,
    markdownLeaks,
    samples,
  };
}

const pct = (n: number, d: number) => `${((100 * n) / (d || 1)).toFixed(1)}%`;

export function renderAudit(r: AuditResult, opts: AuditOptions): string {
  if (opts.json) return `${JSON.stringify(r, null, 2)}\n`;
  const out: string[] = [];
  out.push('CLAIMS AUDIT');
  out.push(`  sessions          ${r.sessions}`);
  out.push(`  agent messages    ${r.messages}`);
  out.push(
    `  produced nothing  ${r.silentMessages}  ${pct(r.silentMessages, r.messages)}  (not narration: a header, a fence, a tool record)`,
  );
  out.push(`  claims            ${r.claims}`);
  out.push(
    `  asserted          ${r.asserted}  ${pct(r.asserted, r.claims)} of claims, ${pct(r.asserted, r.messages)} of messages`,
  );
  out.push(
    `  markdown left in  ${r.markdownLeaks}  ${pct(r.markdownLeaks, r.claims)}  (a marker surviving the flatten)`,
  );

  out.push('', 'BY KIND');
  for (const [k, v] of Object.entries(r.byKind).sort((a, b) => b[1] - a[1]))
    out.push(`  ${k.padEnd(14)} ${String(v).padStart(7)}  ${pct(v, r.claims)}`);

  out.push('', 'BY RULE  (kind/rule; a kind of `other` is recorded and stated nowhere)');
  for (const [k, v] of Object.entries(r.byRule).sort((a, b) => b[1] - a[1]))
    out.push(`  ${String(v).padStart(7)}  ${k}`);

  const sampled = Object.keys(r.samples);
  if (sampled.length > 0) {
    out.push(
      '',
      'SAMPLES',
      '  Precision is a judgement, so this prints the evidence rather than a score.',
      '  Read each block and ask: is every line really that kind? A rule that is wrong more than',
      '  about one time in ten belongs below the threshold.',
    );
    for (const rule of sampled.sort()) {
      const lines = r.samples[rule] ?? [];
      out.push('', `  ── ${rule}  (${r.byRule[rule]} total, ${lines.length} sampled)`);
      for (const l of lines) out.push(`     | ${l.slice(0, 160)}`);
    }
  }
  return `${out.join('\n')}\n`;
}
