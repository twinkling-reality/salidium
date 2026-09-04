import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CollectionStatus } from '@salidium/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '../storage/sqliteStore.ts';
import { readLocalAlerts } from './alerts.ts';
import { resolveOperationalConfig } from './configuration.ts';
import {
  createDiagnosticBundle,
  diagnosticManifest,
  redactDiagnosticValue,
} from './diagnostics.ts';
import { createHealthSnapshot } from './health.ts';

const directories: string[] = [];

function home(): string {
  const path = mkdtempSync(join(tmpdir(), 'salidium-diagnostics-'));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('diagnostic bundle privacy', () => {
  it('redacts secret values, identifying paths, and structurally excluded fields independently', () => {
    const secret = `ghp_${'A'.repeat(32)}`;
    const result = redactDiagnosticValue({
      message: `failed under /Users/alice/private/repo with ${secret}`,
      token: 'plain-token-that-a-pattern-might-miss',
      nested: { cwd: '/Users/alice/private/repo' },
    });
    const text = JSON.stringify(result.value);
    expect(text).not.toContain(secret);
    expect(text).not.toContain('/Users/alice/private/repo');
    expect(text).not.toContain('plain-token-that-a-pattern-might-miss');
    expect(text).toContain('<redacted-path:repo>');
    expect(result.findings).toBeGreaterThanOrEqual(3);
  });

  it('previews an exact inclusion manifest without creating an artifact', () => {
    const manifest = diagnosticManifest(new Date('2026-09-04T12:00:00.000Z'));
    expect(manifest.entries.map((entry) => entry.name)).toEqual([
      'versions',
      'effectiveConfiguration',
      'health',
      'alerts',
      'integrity',
      'logs',
    ]);
    expect(manifest.excludes).toContain('raw canonical events');
  });

  it('writes a private, bounded, redacted JSON bundle without raw events or transcript data', () => {
    const dir = home();
    new SqliteStore(join(dir, 'salidium.db')).close();
    const config = resolveOperationalConfig(dir, { environment: {} });
    const observedAt = '2026-09-04T12:00:00.000Z';
    const collection: CollectionStatus = {
      observedAt,
      state: 'active',
      pause: null,
      queue: { files: 0, bytes: 0, oldestAt: null },
      store: { bytes: 0, retention: 'forever', lastIngestAt: null },
      health: 'healthy',
      gaps: { active: [], recovered: [], omittedEpisodes: 0 },
    };
    const health = createHealthSnapshot({
      home: dir,
      collection,
      daemon: { state: 'running', pid: 42, startedAt: observedAt, version: '1.0.0' },
      hooks: [],
      maintenance: null,
      config,
      history: [],
      schemaVersion: 7,
      layoutVersion: 1,
      now: new Date(observedAt),
    });
    const secret = `ghp_${'B'.repeat(32)}`;
    writeFileSync(
      join(dir, 'daemon.log'),
      `${observedAt} warn failed {"path":"/Users/alice/private/repo/file.ts","token":"${secret}","sessionId":"0199aabb-ccdd-eeff-0011-223344556677","file":"codex-20260904-deadbeef.json"}\n`,
    );
    const outputDirectory = join(dir, 'exports');
    mkdirSync(outputDirectory, { mode: 0o755 });
    chmodSync(outputDirectory, 0o755);
    const output = join(outputDirectory, 'bundle.json');

    const result = createDiagnosticBundle({
      home: dir,
      outputPath: output,
      version: '1.0.0',
      protocolVersion: '2',
      storeSchemaVersion: 7,
      config,
      health,
      alerts: readLocalAlerts(dir, new Date(observedAt)),
      now: new Date(observedAt),
    });

    const text = readFileSync(output, 'utf8');
    const parsed = JSON.parse(text) as { manifest: { excludes: string[] }; sections: unknown };
    expect(text).not.toContain(secret);
    expect(text).not.toContain('/Users/alice');
    expect(text).not.toContain('0199aabb-ccdd-eeff-0011-223344556677');
    expect(text).not.toContain('codex-20260904-deadbeef.json');
    expect(JSON.stringify(parsed.sections)).not.toMatch(/"(?:raw|event|transcript)"\s*:/i);
    expect(parsed.manifest.excludes).toContain('raw canonical events');
    expect(result.redactions).toBeGreaterThan(0);
    expect(result.bytes).toBeLessThan(400 * 1024);
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(statSync(outputDirectory).mode & 0o777).toBe(0o755);
    expect(() =>
      createDiagnosticBundle({
        home: dir,
        outputPath: output,
        version: '1.0.0',
        protocolVersion: '2',
        storeSchemaVersion: 7,
        config,
        health,
        alerts: readLocalAlerts(dir),
      }),
    ).toThrow(/refusing to overwrite/);
  });
});
