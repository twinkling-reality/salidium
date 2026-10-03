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
      HOME: home,
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

  it.skipIf(process.platform === 'win32')(
    'still resolves a private git when the filesystem root is an untrusted root',
    () => {
      const root = temporaryDirectory();
      const bin = join(root, 'bin');
      const project = join(root, 'project');
      mkdirSync(bin, { recursive: true });
      mkdirSync(project, { recursive: true });
      executable(join(bin, 'git'));
      executable(join(project, 'git'));

      const resolved = join(realpathSync(bin), 'git');
      expect(
        resolveTrustedExecutable('git', {
          environment: { PATH: bin },
          untrustedRoots: ['/'],
        }),
      ).toBe(resolved);
      expect(
        resolveTrustedExecutable('git', {
          environment: { PATH: [project, bin].join(delimiter) },
          untrustedRoots: ['/', project],
        }),
      ).toBe(resolved);
    },
  );

  it('rejects project-owned PATH directories and symlink targets outside node_modules', () => {
    const root = temporaryDirectory();
    const project = join(root, 'project');
    const projectBin = join(project, 'bin');
    const installedBin = join(root, 'installed', 'bin');
    mkdirSync(projectBin, { recursive: true });
    mkdirSync(installedBin, { recursive: true });
    executable(join(projectBin, 'codex'));
    symlinkSync(join(projectBin, 'codex'), join(installedBin, 'codex'));

    const environment = { PATH: [projectBin, installedBin].join(delimiter) };
    expect(trustedPathEntries({ environment, untrustedRoots: [project] })).toEqual([
      realpathSync(installedBin),
    ]);
    expect(
      resolveTrustedExecutable('codex', { environment, untrustedRoots: [project] }),
    ).toBeUndefined();
  });

  // Only a POSIX host states access in the mode bits this rule reads. Windows reports 0o777 for
  // any writable directory and keeps the real permission in an ACL, so asserting the rule there
  // would test the fixture's attributes rather than the boundary.
  it.skipIf(process.platform === 'win32')(
    'rejects group- or world-writable executable directories',
    () => {
      const root = temporaryDirectory();
      const writable = join(root, 'shared-bin');
      mkdirSync(writable, { mode: 0o777 });
      chmodSync(writable, 0o777);
      executable(join(writable, 'git'));

      expect(trustedPathEntries({ environment: { PATH: writable }, untrustedRoots: [] })).toEqual(
        [],
      );
      expect(
        resolveTrustedExecutable('git', { environment: { PATH: writable }, untrustedRoots: [] }),
      ).toBeUndefined();
    },
  );
});
