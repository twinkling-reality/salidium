const RESET = '\u001b[0m';

const ANSI = {
  bold: '\u001b[1m',
  accent: '\u001b[38;2;143;166;255m',
  accentBackground: '\u001b[48;2;59;91;219m\u001b[38;2;255;255;255m',
  textMuted: '\u001b[38;2;142;142;139m',
  rail: '\u001b[38;2;91;91;88m',
  ok: '\u001b[38;2;95;207;136m',
  warn: '\u001b[38;2;224;168;60m',
  danger: '\u001b[38;2;240;115;106m',
  claude: '\u001b[38;2;231;155;125m',
  codex: '\u001b[38;2;79;196;163m',
} as const;

export type TerminalTone = 'accent' | 'ok' | 'warn' | 'danger' | 'muted' | 'claude' | 'codex';

function paint(enabled: boolean, code: string, value: string): string {
  return enabled ? `${code}${value}${RESET}` : value;
}

/**
 * The terminal is Salidium's first surface. This renderer gives it the same restrained semantic
 * palette as the browser without assuming control of the reader's terminal theme. Background
 * colour is reserved for the product badge and the active choice; status and provider colours
 * remain small signals, just as they do in the app.
 */
export class TerminalUi {
  readonly color: boolean;

  constructor(color = false) {
    this.color = color;
  }

  private tone(value: string, tone: TerminalTone): string {
    const code =
      tone === 'muted'
        ? ANSI.textMuted
        : tone === 'claude'
          ? ANSI.claude
          : tone === 'codex'
            ? ANSI.codex
            : ANSI[tone];
    return paint(this.color, code, value);
  }

  private bold(value: string): string {
    return paint(this.color, ANSI.bold, value);
  }

  private rail(glyph: string): string {
    return paint(this.color, ANSI.rail, glyph);
  }

  header(firstRun: boolean): string {
    const brand = paint(this.color, ANSI.accentBackground, ' SALIDIUM ');
    const mode = this.tone(firstRun ? 'FIRST-RUN SETUP' : 'AGENT SETUP', 'muted');
    return `\n  ${brand}  ${mode}\n  ${this.tone('Connect your coding agents', 'muted')}\n`;
  }

  section(label: string): string {
    return `\n  ${this.tone('◆', 'accent')}  ${this.bold(label.toUpperCase())}\n`;
  }

  copy(text: string): string {
    return `  ${this.rail('│')}  ${text}\n`;
  }

  spacer(): string {
    return `  ${this.rail('│')}\n`;
  }

  status(mark: string, label: string, detail: string, tone: TerminalTone): string {
    return `  ${this.rail('│')}  ${this.tone(mark, tone)} ${this.bold(label.padEnd(14))} ${this.tone(detail, 'muted')}\n`;
  }

  path(provider: string, providerId: 'claude-code' | 'codex', value: string): string {
    const tone = providerId === 'claude-code' ? 'claude' : 'codex';
    return [
      `  ${this.rail('│')}  ${this.tone(provider, tone)}\n`,
      `  ${this.rail('│')}  ${this.rail('└─')} ${this.tone(value, 'muted')}\n`,
    ].join('');
  }

  attention(text: string): string {
    return `  ${this.rail('│')}  ${this.tone('!', 'warn')} ${text}\n`;
  }

  item(mark: string, text: string, tone: TerminalTone): string {
    return `  ${this.rail('│')}  ${this.tone(mark, tone)} ${text}\n`;
  }

  failure(text: string): string {
    return `  ${this.rail('│')}  ${this.tone('×', 'danger')} ${text}\n`;
  }

  choices(label: string, options: readonly string[], selectedIndex: number): string {
    const selected = (value: string) =>
      this.color ? paint(true, ANSI.accentBackground, ` ${value} `) : `[ ${value} ]`;
    const idle = (value: string) => this.tone(` ${value} `, 'muted');
    const rendered = options
      .map((option, index) => (index === selectedIndex ? selected(option) : idle(option)))
      .join(' ');
    return `  ${this.rail('├─')} ${this.bold(label)}  ${rendered}`;
  }

  choice(label: string, yes: boolean): string {
    return this.choices(label, ['No', 'Yes'], yes ? 1 : 0);
  }

  close(mark: string, text: string, tone: TerminalTone = 'muted'): string {
    return `  ${this.rail('└─')} ${this.tone(mark, tone)} ${text}\n`;
  }

  open(url: string, opened: boolean, firstRun = false): string {
    const label = opened ? 'OPENED' : 'LOCAL URL';
    const mark = opened ? '↗' : '→';
    const urlRail = firstRun ? '├─' : '└─';
    const next = firstRun
      ? `  ${this.rail('└─')} ${this.tone('NEXT', 'muted')} ${this.bold('npx salidium')}\n`
      : '';
    return `\n  ${this.tone('◆', 'accent')}  ${this.bold(label)}\n  ${this.rail(urlRail)} ${this.tone(mark, 'accent')} ${this.tone(url, 'accent')}\n${next}\n`;
  }

  running(explanations: string, detail: string): string {
    return [
      this.section('Running'),
      this.status('✓', 'Salidium', 'Background service is active', 'ok'),
      this.status(
        '●',
        'Explanations',
        `${explanations} · ${detail}`,
        explanations === 'Local only' ? 'ok' : 'accent',
      ),
      this.item('→', 'Stop service: salidium stop', 'muted'),
      this.close('→', 'Stop model calls: salidium explanations off'),
    ].join('');
  }
}

export function supportsTerminalColor(
  isTty: boolean,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return isTty && !('NO_COLOR' in environment) && environment.TERM !== 'dumb';
}

export function homeRelative(path: string, userHome: string): string {
  if (path === userHome) return '~';
  return path.startsWith(`${userHome}/`) ? `~${path.slice(userHome.length)}` : path;
}

export interface ConsentKeyResult {
  selected: boolean;
  decision?: boolean;
  aborted?: boolean;
}

export interface SelectionKeyResult {
  selectedIndex: number;
  decision?: number;
  aborted?: boolean;
}

/** A small, reusable terminal selector: horizontal choices, arrows or numbers, Enter to confirm. */
export function selectionKeyResult(
  key: string,
  selectedIndex: number,
  optionCount: number,
): SelectionKeyResult {
  const last = Math.max(0, optionCount - 1);
  const selected = Math.max(0, Math.min(last, selectedIndex));
  if (key === '\u0003') return { selectedIndex: selected, aborted: true };
  if (key === '\r' || key === '\n') return { selectedIndex: selected, decision: selected };
  if (key === '\u001b') return { selectedIndex: 0, decision: 0 };
  if (key === '\u001b[D') return { selectedIndex: Math.max(0, selected - 1) };
  if (key === '\u001b[C' || key === '\t' || key === ' ')
    return { selectedIndex: Math.min(last, selected + 1) };
  if (/^[1-9]$/.test(key)) {
    const direct = Number(key) - 1;
    if (direct <= last) return { selectedIndex: direct, decision: direct };
  }
  return { selectedIndex: selected };
}

/** Arrow keys move the visible choice. Y/N remain immediate shortcuts for experienced CLI users. */
export function consentKeyResult(key: string, selected: boolean): ConsentKeyResult {
  if (key === 'y' || key === 'Y') return { selected: true, decision: true };
  if (key === 'n' || key === 'N') return { selected: false, decision: false };
  if (key === '\t' || key === ' ') return { selected: !selected };
  const result = selectionKeyResult(key, selected ? 1 : 0, 2);
  return {
    selected: result.selectedIndex === 1,
    ...(result.decision === undefined ? {} : { decision: result.decision === 1 }),
    ...(result.aborted ? { aborted: true } : {}),
  };
}
