import { describe, expect, it } from 'vitest';
import {
  consentKeyResult,
  homeRelative,
  selectionKeyResult,
  supportsTerminalColor,
  TerminalUi,
} from './terminalUi.ts';

describe('terminal UI', () => {
  it('keeps the setup hierarchy when colour is unavailable', () => {
    const ui = new TerminalUi(false);
    const output = [
      ui.header(true),
      ui.section('Agents'),
      ui.status('●', 'Codex', 'Detected', 'codex'),
      ui.section('Permission'),
      ui.path('Codex', 'codex', '~/.codex/hooks.json'),
      ui.choice('Connect Codex?', false),
      ui.choices('Written Why + How', ['Local only', 'When done', 'Each reply'], 0),
    ].join('');

    expect(output).not.toContain('\u001b[');
    expect(output).toMatch(/SALIDIUM\s+FIRST-RUN SETUP/);
    expect(output).toContain('│  ● Codex');
    expect(output).toContain('│  └─ ~/.codex/hooks.json');
    expect(output).toContain('├─ Connect Codex?  [ No ]  Yes ');
    expect(output).toContain('├─ Written Why + How  [ Local only ]  When done   Each reply ');
  });

  it('uses ANSI colour only for an eligible terminal', () => {
    const output = new TerminalUi(true).header(true);
    expect(output).toContain('\u001b[48;2;59;91;219m');
    expect(supportsTerminalColor(true, { TERM: 'xterm-256color' })).toBe(true);
    expect(supportsTerminalColor(false, { TERM: 'xterm-256color' })).toBe(false);
    expect(supportsTerminalColor(true, { TERM: 'dumb' })).toBe(false);
    expect(supportsTerminalColor(true, { TERM: 'xterm-256color', NO_COLOR: '1' })).toBe(false);
  });

  it('shows owned settings beneath a readable home-relative path', () => {
    expect(homeRelative('/Users/person/.codex/hooks.json', '/Users/person')).toBe(
      '~/.codex/hooks.json',
    );
    expect(homeRelative('/tmp/another/hooks.json', '/Users/person')).toBe(
      '/tmp/another/hooks.json',
    );
  });

  it('moves and confirms the consent choice from arrows or direct keys', () => {
    expect(consentKeyResult('\u001b[C', false)).toEqual({ selected: true });
    expect(consentKeyResult('\u001b[D', true)).toEqual({ selected: false });
    expect(consentKeyResult('\r', true)).toEqual({ selected: true, decision: true });
    expect(consentKeyResult('n', true)).toEqual({ selected: false, decision: false });
    expect(consentKeyResult('\u0003', false)).toEqual({ selected: false, aborted: true });
  });

  it('moves and confirms a horizontal multi-option choice', () => {
    expect(selectionKeyResult('\u001b[C', 0, 3)).toEqual({ selectedIndex: 1 });
    expect(selectionKeyResult('\u001b[D', 1, 3)).toEqual({ selectedIndex: 0 });
    expect(selectionKeyResult('3', 0, 3)).toEqual({ selectedIndex: 2, decision: 2 });
    expect(selectionKeyResult('\r', 2, 3)).toEqual({ selectedIndex: 2, decision: 2 });
    expect(selectionKeyResult('\u0003', 1, 3)).toEqual({ selectedIndex: 1, aborted: true });
  });
});
