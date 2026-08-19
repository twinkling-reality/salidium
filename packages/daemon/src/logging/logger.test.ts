import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, rotateLogFile } from './logger.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('bounded daemon logs', () => {
  it('rotates a bounded numbered history before reopening the structured log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'salidium-log-'));
    dirs.push(dir);
    const file = join(dir, 'daemon.log');
    writeFileSync(file, 'first-log');
    expect(rotateLogFile(file, 4, 2)).toBe(true);
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('first-log');

    writeFileSync(file, 'second-log');
    expect(rotateLogFile(file, 4, 2)).toBe(true);
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('second-log');
    expect(readFileSync(`${file}.2`, 'utf8')).toBe('first-log');

    writeFileSync(file, 'third-log');
    expect(rotateLogFile(file, 4, 2)).toBe(true);
    expect(readFileSync(`${file}.2`, 'utf8')).toBe('second-log');
  });

  it('continues writing a fresh base file after rotation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'salidium-log-write-'));
    dirs.push(dir);
    const file = join(dir, 'daemon.log');
    writeFileSync(file, 'x'.repeat(6 * 1024 * 1024));

    createLogger('info', file).info('after rotation');

    expect(readFileSync(file, 'utf8')).toContain('after rotation');
    expect(existsSync(`${file}.1`)).toBe(true);
  });
});
