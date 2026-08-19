import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveTrustedExecutable, trustedPathEntries } from './trustedExecutable.ts';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'salidium-path-'));
  temporaryDirectories.push(path);
  return path;
}

function executable(path: string): void {
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o700);
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('trusted executable resolution', () => {
  it('ignores relative and project package bins, but accepts a home-local installation', () => {
    const root = temporaryDirectory();
    const home = join(root, 'home');
    const project = join(home, 'project');
    const projectBin = join(project, 'node_modules', '.bin');
    const trustedBin = join(home, '.local', 'bin');
    mkdirSync(projectBin, { recursive: true });
    mkdirSync(trustedBin, { recursive: true });
    executable(join(projectBin, 'claude'));
    executable(join(trustedBin, 'claude'));

    const environment = {
      PATH: ['node_modules/.bin', projectBin, trustedBin].join(delimiter),
    };
    const resolvedBin = realpathSync(trustedBin);
    expect(trustedPathEntries({ environment, cwd: home })).toEqual([resolvedBin]);
    expect(resolveTrustedExecutable('claude', { environment, cwd: home })).toBe(
      join(resolvedBin, 'claude'),
    );
  });

  it('does not follow a trusted-directory symlink into node_modules/.bin', () => {
    const root = temporaryDirectory();
    const project = join(root, 'project');
    const projectBin = join(project, 'node_modules', '.bin');
    const trustedBin = join(root, 'installed', 'bin');
    mkdirSync(projectBin, { recursive: true });
    mkdirSync(trustedBin, { recursive: true });
    executable(join(projectBin, 'codex'));
    const linked = join(trustedBin, 'codex');
    // A symlink is how package managers commonly expose commands, so only its target is judged.
    writeFileSync(linked, '');
    rmSync(linked);
    symlinkSync(join(projectBin, 'codex'), linked);

    expect(
      resolveTrustedExecutable('codex', { environment: { PATH: trustedBin } }),
    ).toBeUndefined();
  });
});
