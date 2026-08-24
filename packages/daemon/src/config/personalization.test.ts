import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deletePersonalization,
  EMPTY_PERSONALIZATION,
  nextPersonalization,
  personalizationPath,
  readPersonalization,
  writePersonalization,
} from './personalization.ts';

const directories: string[] = [];

function home(): string {
  const path = mkdtempSync(join(tmpdir(), 'salidium-personalization-'));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const request = {
  enabled: true,
  profile: {
    guidance: 'I run payment operations. Use restaurant kitchens as examples. Call jobs workers.',
  },
};

describe('the local personalization profile', () => {
  it('is absent by default and stored in its own 0600 file', () => {
    const dir = home();
    expect(readPersonalization(dir)).toEqual(EMPTY_PERSONALIZATION);
    const settings = nextPersonalization(request);
    writePersonalization(dir, settings);
    expect(readPersonalization(dir)).toEqual(settings);
    expect(statSync(personalizationPath(dir)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(personalizationPath(dir), 'utf8'))).toEqual(settings);
  });

  it('fails closed independently and deletion removes the profile file', () => {
    const dir = home();
    writeFileSync(personalizationPath(dir), '{not-json');
    const warnings: string[] = [];
    expect(readPersonalization(dir, (reason) => warnings.push(reason))).toEqual(
      EMPTY_PERSONALIZATION,
    );
    expect(warnings).toHaveLength(1);
    deletePersonalization(dir);
    expect(readPersonalization(dir)).toEqual(EMPTY_PERSONALIZATION);
    expect(() => deletePersonalization(dir)).not.toThrow();
  });

  it('gives every successful replacement a fresh revision', () => {
    expect(nextPersonalization(request).revision).not.toBe(nextPersonalization(request).revision);
  });

  it('atomically replaces a strict v1 profile with one v2 guidance note', () => {
    const dir = home();
    const legacyRevision = 'legacy-revision';
    writeFileSync(
      personalizationPath(dir),
      JSON.stringify({
        version: 1,
        enabled: true,
        revision: legacyRevision,
        profile: {
          context: 'I run payment operations.',
          familiarExamples: ['restaurant kitchens'],
          terminology: 'Call jobs workers.',
          detail: 'plain',
        },
      }),
      { mode: 0o600 },
    );

    const migrated = readPersonalization(dir);
    expect(migrated).toMatchObject({
      version: 2,
      enabled: true,
      profile: {
        guidance:
          'I run payment operations. Use examples from restaurant kitchens. Call jobs workers. Use plain language.',
      },
    });
    expect(migrated.revision).not.toBe(legacyRevision);
    expect(JSON.parse(readFileSync(personalizationPath(dir), 'utf8'))).toEqual(migrated);
    expect(statSync(personalizationPath(dir)).mode & 0o777).toBe(0o600);
  });
});
