import type { ReportView, SessionView } from '@salidium/core';

/**
 * The terminal rendering of the same report the UI draws. Both read one `SessionView`, so the
 * two surfaces cannot drift: if a fact is missing here it is missing there too.
 *
 * Box-drawing characters are used deliberately — this is the one place where the layout is fixed
 * width, so a drawn box is exact rather than approximate. Everything wraps to `width`, defaulting
 * to the terminal's own columns.
 */

const H = '─';

/**
 * Control characters, stripped at the one boundary that interprets them.
 *
 * Everything this renderer prints was written by an agent, or read somewhere by an agent and
 * repeated. A terminal acts on an escape sequence where a browser shows it inertly, so one in a
 * plan item repaints the lines above it, and the lines above it are the ones saying whether the
 * checks passed. It also breaks the boxes outright: `wrap` and `padEnd` count an escape sequence
 * as the several characters it occupies and none of the columns it draws in.
 *
 * The newline goes with the rest, and that is the point rather than an oversight: several of these
 * lines are pushed whole instead of through `wrap` — a plan item is one — so a newline inside one
 * becomes a line of its own in the output, free of any prefix or box, and able to read as anything
 * at all, including a passing check. `wrap` splits its paragraphs before cleaning them, so real
 * multi-line text still wraps. They become spaces rather than nothing, so a word is not joined to
 * its neighbour. Nothing is stripped at ingest: the stored event stays exactly what the provider
 * wrote, so `record` still shows a reader the real bytes.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are the subject.
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;

function plain(text: string): string {
  return text.replace(CONTROL, ' ');
}

/**
 * Word wrap that also hard-breaks a token longer than the line. Without that a single long path
 * runs straight through the right-hand border and the box stops being a box.
 */
function wrap(raw: string, width: number): string[] {
  const out: string[] = [];
  const push = (line: string) => {
    let rest = line;
    while (rest.length > width) {
      out.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    out.push(rest);
  };
  for (const paragraph of raw.split('\n')) {
    let line = '';
    for (const word of plain(paragraph).split(/\s+/).filter(Boolean)) {
      if (line.length === 0) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        push(line);
        line = word;
      }
    }
    push(line);
  }
  return out.length > 0 ? out : [''];
}

/** A titled box. The title sits in the top rule, so it costs no extra line. */
function box(title: string, body: string[], width: number): string[] {
  const inner = width - 4;
  const head = `┌─ ${title} ${H.repeat(Math.max(0, width - title.length - 5))}┐`;
  const lines = body.flatMap((l) => wrap(l, inner));
  return [head, ...lines.map((l) => `│ ${l.padEnd(inner)} │`), `└${H.repeat(width - 2)}┘`];
}

/** A vertical chain, drawn the way a terminal can draw it. */
function chain(items: string[], width: number): string[] {
  const out: string[] = [];
  items.forEach((text, i) => {
    if (i > 0) {
      out.push('       │');
      out.push('       v');
    }
    for (const l of wrap(text, width - 8)) out.push(`  ${l}`);
  });
  return out;
}

/**
 * The generated explanation. The web makes this the page, so the terminal leads with it too —
 * otherwise the two renderings disagree about what the session is *about*, which is exactly the
 * drift one shared `SessionView` exists to prevent.
 *
 * It says who wrote it before it says anything else, and it contributes nothing to VERIFIED, LEFT
 * or REVIEW below.
 */
function explained(ex: NonNullable<SessionView['explained']>, width: number): string[] {
  const body: string[] = [`Written by ${ex.model} from the evidence below, not observed.`, ''];
  body.push(ex.what.summary);
  if (ex.what.currently) body.push('', `Now: ${ex.what.currently}`);

  if (ex.why.lanes.length > 0 || ex.why.chain.length > 0) {
    body.push('', 'WHY');
    for (const lane of ex.why.lanes) {
      body.push(`  ${lane.title}`);
      for (const s of lane.steps) body.push(`    · ${s}`);
    }
    // The lanes converge on the trunk; in a fixed-width box that junction is a rule, not a bus.
    if (ex.why.lanes.length > 1 && ex.why.chain.length > 0) body.push(`  ${H.repeat(width - 8)}`);
    body.push(...chain(ex.why.chain, width));
  }

  if (ex.how.steps.length > 0) {
    body.push('', 'HOW');
    if (ex.how.root) body.push(`  ${ex.how.root}`);
    ex.how.steps.forEach((s, i) => {
      body.push(`  ${i === ex.how.steps.length - 1 ? '└' : '├'} ${s}`);
    });
  }

  const ac = ex.approachChange;
  if (ac) {
    body.push('', 'APPROACH CHANGED');
    body.push(`  Was: ${ac.from}`);
    for (const s of ac.fromSteps) body.push(`    · ${s}`);
    body.push('    ✕');
    if (ac.why) body.push(`  ${ac.why}`);
    body.push(`  Now: ${ac.to}`);
    for (const s of ac.toSteps) body.push(`    · ${s}`);
    body.push('    ✓');
  }
  return box('EXPLAINED', body, width);
}

function duration(ms: number | undefined): string {
  if (ms === undefined) return 'unknown';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function mark(outcome: string): string {
  return outcome === 'pass' ? '✓' : outcome === 'fail' ? '✕' : outcome === 'partial' ? '◐' : '?';
}

export interface RenderOptions {
  width?: number;
  /** 0 = summary, 1 = detail, 2 = source. Matches the UI's one control. */
  detail?: 0 | 1 | 2;
  project: string;
  agent: string;
  status: string;
  /** Project root, so paths can be shown relative to it. */
  cwd?: string;
}

export function renderReport(view: SessionView, opts: RenderOptions): string {
  const width = Math.min(Math.max(opts.width ?? process.stdout.columns ?? 80, 48), 100);
  const detail = opts.detail ?? 1;
  const r: ReportView = view.report;
  const out: string[] = [];

  out.push('SALIDIUM');
  out.push(`Project:  ${opts.project}`);
  out.push(`Agent:    ${opts.agent}`);
  out.push(`Run time: ${duration(r.runtimeMs)}`);
  out.push(`Status:   ${opts.status}`);
  out.push('');

  if (view.explained) out.push(...explained(view.explained, width), '');

  /*
   * The agent's own account used to be three boxes here — What, Why, How — relaying its narration
   * as prose. Every part of it was already carried better: the findings by the explanation's Why,
   * the steps by the run history, the files by churn, the plan by Left. What the boxes added was
   * the raw chat message laid out as a report, which is the one thing this tool exists to spare a
   * reader. The exact words remain reachable through the records. Only the ask survives, because
   * nothing else on the page states it.
   */
  if (r.ask) {
    out.push(...box('ASKED', wrap(r.ask.text, width - 4), width), '');
  }

  out.push('VERIFIED');
  if (view.verified.summary.length === 0) out.push('  No checks observed.');
  for (const v of view.verified.summary) {
    const counts =
      v.counts?.total !== undefined ? ` ${v.counts.passed ?? 0} / ${v.counts.total}` : '';
    const derived = detail > 1 && v.epistemic === 'inferred' ? '  (derived)' : '';
    // Same rule as the web: an outcome that is not the newest one says so beside itself.
    const notLatest = v.laterUnreadable > 0 ? '  (not the latest run)' : '';
    out.push(`${mark(v.outcome)} ${v.method}${counts}${notLatest}${derived}`);
  }
  out.push('');

  out.push('LEFT');
  if (view.left.items.length === 0) out.push('  Nothing recorded.');
  for (const i of detail === 0 ? view.left.items.slice(0, 3) : view.left.items)
    out.push(`${i.status === 'failing' ? '✕' : i.status === 'in_progress' ? '▸' : '○'} ${i.text}`);
  out.push('');

  /*
   * One line per rule, not per occurrence, exactly as the web draws it: a run that clears a cache
   * before each of twenty test runs is one thing to know, and twenty identical lines is a wall
   * that costs the reader the rest of the section. The occurrences print underneath at Records
   * depth, folded so an identical command is stated once with a count.
   */
  const attention = view.review.groups.filter((g) => g.severity !== 'info');
  out.push('REVIEW');
  if (attention.length === 0) out.push('  Nothing needs you.');
  for (const g of attention) {
    const distinct = g.items.length < g.occurrences ? `, ${g.items.length} distinct` : '';
    const count = g.occurrences > 1 ? `  (${g.occurrences}${distinct})` : '';
    const head = g.occurrences === 1 ? (g.items[0]?.summary ?? g.label) : g.label;
    for (const l of wrap(`⚠ ${head}${count}`, width)) out.push(l);
    // Indented after wrapping, not before: `wrap` splits on whitespace and rejoins with single
    // spaces, so a leading indent written into the text is the first thing it discards.
    if (detail > 1 && g.occurrences > 1)
      for (const i of g.items)
        for (const l of wrap(
          `${i.instance ?? i.label}${i.repeats > 1 ? `  ×${i.repeats}` : ''}`,
          width - 4,
        ))
          out.push(`    ${l}`);
  }

  // Every line, whether it went through `wrap` or was pushed whole.
  return `${out.map(plain).join('\n')}\n`;
}
