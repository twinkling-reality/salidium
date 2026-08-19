import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBrowserLaunch, validateSalidiumPort } from './runtime.ts';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'salidium-cli-runtime-'));
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

describe('CLI runtime boundaries', () => {
  it.each([undefined, '0', '1', '47822', '65535'])(
    'accepts a valid SALIDIUM_PORT value (%s)',
    (port) => {
      expect(() => validateSalidiumPort(port)).not.toThrow();
    },
  );

  it.each(['', '-1', '1.5', '65536', 'text', ' 47822 '])(
    'rejects a bad SALIDIUM_PORT value before launch (%s)',
    (port) => {
      expect(() => validateSalidiumPort(port)).toThrow(/integer from 0 to 65535/);
    },
  );

  it('resolves the OS opener absolutely and gives it a project-bin-free PATH', () => {
    const root = temporaryDirectory();
    const projectBin = join(root, 'project', 'node_modules', '.bin');
    const systemBin = join(root, 'system-bin');
    mkdirSync(projectBin, { recursive: true });
    mkdirSync(systemBin, { recursive: true });
    executable(join(projectBin, 'open'));
    executable(join(systemBin, 'open'));

    const launch = resolveBrowserLaunch('http://127.0.0.1:47822/', {
      platform: 'darwin',
      environment: { PATH: [projectBin, systemBin].join(delimiter) },
    });
    const resolvedSystemBin = realpathSync(systemBin);
    expect(launch?.command).toBe(join(resolvedSystemBin, 'open'));
    expect(launch?.args).toEqual(['http://127.0.0.1:47822/']);
    expect(launch?.environment.PATH).toBe(resolvedSystemBin);
  });
});
