import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRedactor } from '@salidium/core';
import type {
  DiagnosticBundleManifest,
  EffectiveOperationalConfig,
  LocalAlertState,
  OperationsHealthSnapshot,
} from '@salidium/protocol';
import { DiagnosticBundleManifestSchema } from '@salidium/protocol';
import { writePrivateJsonAtomic } from './files.ts';

export const MAX_DIAGNOSTIC_LOG_BYTES = 256 * 1024;

const EXCLUDED_KEYS =
  /^(?:token|authorization|secret|password|prompt|command|raw|events?|transcript|cwd|repoRoot|home|path|file|filename|sessionId|providerSessionId|agentId)$/i;
const ABSOLUTE_PATH = /(?:[A-Za-z]:\\|\/(?!\/))(?:[^\s"'<>|]+[\\/])*[^\s"'<>|]*/g;

export interface DiagnosticRedaction {
  value: unknown;
  findings: number;
}

/** Independent from bundle assembly so privacy rules can be fuzzed and audited on their own. */
export function redactDiagnosticValue(input: unknown): DiagnosticRedaction {
  const redactor = createRedactor();
  let pathFindings = 0;
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const secretSafe = redactor.redact(value).text;
      return secretSafe.replace(ABSOLUTE_PATH, (match) => {
        pathFindings += 1;
        const suffix = basename(match.replaceAll('\\', '/'));
        return suffix && suffix !== '/' ? `<redacted-path:${suffix}>` : '<redacted-path>';
      });
    }
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (EXCLUDED_KEYS.test(key)) {
        out[key] = `<redacted-${key.toLowerCase()}>`;
        pathFindings += 1;
      } else out[key] = visit(child);
    }
    return out;
  };
  const value = visit(input);
  return { value, findings: redactor.findingsCount + pathFindings };
}

function readTail(path: string, maximumBytes: number): string {
  if (!existsSync(path)) return '';
  const size = statSync(path).size;
  const length = Math.min(size, maximumBytes);
  const buffer = Buffer.alloc(length);
  const descriptor = openSync(path, 'r');
  try {
    readSync(descriptor, buffer, 0, length, Math.max(0, size - length));
  } finally {
    closeSync(descriptor);
  }
  const text = buffer.toString('utf8');
  if (length === size) return text;
  const newline = text.indexOf('\n');
  return newline === -1 ? text : text.slice(newline + 1);
}

/**
 * Logger lines end in a JSON object. Preserve the readable message while making those fields
 * structural so the recursive key allowlist can remove session ids and identifying filenames.
 */
function structuredLogTail(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let parsed = false;
    for (let offset = line.indexOf('{'); offset >= 0; offset = line.indexOf('{', offset + 1)) {
      try {
        const fields = JSON.parse(line.slice(offset)) as unknown;
        out.push({ message: line.slice(0, offset).trimEnd(), fields });
        parsed = true;
        break;
      } catch {
        /* A message can contain a brace; try the next one before treating it as plain text. */
      }
    }
    if (!parsed) out.push(line);
  }
  return out;
}

export function diagnosticManifest(now = new Date()): DiagnosticBundleManifest {
  return DiagnosticBundleManifestSchema.parse({
    contractVersion: 1,
    bundleSchemaVersion: 1,
    createdAt: now.toISOString(),
    privacy: 'redacted-local-diagnostics',
    excludes: [
      'transcript contents',
      'raw canonical events',
      'prompts and command output',
      'authentication tokens and secrets',
      'absolute and identifying paths',
    ],
    entries: [
      {
        name: 'versions',
        description: 'Salidium, wire-contract, configuration, store schema, and platform versions.',
        maximumBytes: 4096,
        redactions: ['identifying paths'],
      },
      {
        name: 'effectiveConfiguration',
        description: 'Supported policy values with default, stored, or environment source labels.',
        maximumBytes: 32 * 1024,
        redactions: ['secret-like values', 'identifying paths'],
      },
      {
        name: 'health',
        description: 'One aggregate health snapshot and derived-rate metadata.',
        maximumBytes: 32 * 1024,
        redactions: ['queue filenames', 'identifying paths'],
      },
      {
        name: 'alerts',
        description: 'Bounded local alert states without event or transcript bodies.',
        maximumBytes: 64 * 1024,
        redactions: ['secret-like values', 'identifying paths'],
      },
      {
        name: 'integrity',
        description: 'SQLite quick-check result gathered only when the bundle is written.',
        maximumBytes: 4096,
        redactions: [],
      },
      {
        name: 'logs',
        description: 'The bounded tail of operational and launcher logs.',
        maximumBytes: MAX_DIAGNOSTIC_LOG_BYTES,
        redactions: ['secrets and tokens', 'absolute and identifying paths'],
      },
    ],
  });
}

function storeIntegrity(home: string): { result: string; checkedAt: string } {
  const checkedAt = new Date().toISOString();
  const path = join(home, 'salidium.db');
  if (!existsSync(path)) return { result: 'store-not-found', checkedAt };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('PRAGMA quick_check(10)').get() as Record<string, unknown> | undefined;
    return { result: String(row ? Object.values(row)[0] : 'no-result'), checkedAt };
  } catch (error) {
    return {
      result: `unavailable: ${error instanceof Error ? error.message : String(error)}`,
      checkedAt,
    };
  } finally {
    db.close();
  }
}

export interface DiagnosticBundleInput {
  home: string;
  outputPath: string;
  version: string;
  protocolVersion: string;
  storeSchemaVersion: number | null;
  config: EffectiveOperationalConfig;
  health: OperationsHealthSnapshot;
  alerts: LocalAlertState;
  platform?: { platform: string; release: string; arch: string; node: string };
  now?: Date;
}

export interface DiagnosticBundleResult {
  path: string;
  bytes: number;
  redactions: number;
  manifest: DiagnosticBundleManifest;
}

export function createDiagnosticBundle(input: DiagnosticBundleInput): DiagnosticBundleResult {
  if (existsSync(input.outputPath))
    throw new Error(`refusing to overwrite existing bundle: ${input.outputPath}`);
  const manifest = diagnosticManifest(input.now);
  const health = structuredClone(input.health) as unknown as Record<string, unknown>;
  // Queue filenames are useful for interactive inspection but add no diagnostic value to a bundle.
  if (health.queue && typeof health.queue === 'object')
    delete (health.queue as Record<string, unknown>).entries;
  const logs = structuredLogTail(
    [
      readTail(join(input.home, 'daemon.log'), Math.floor(MAX_DIAGNOSTIC_LOG_BYTES * 0.75)),
      readTail(join(input.home, 'daemon-startup.log'), Math.floor(MAX_DIAGNOSTIC_LOG_BYTES * 0.25)),
    ]
      .filter(Boolean)
      .join('\n'),
  );
  const redacted = redactDiagnosticValue({
    versions: {
      salidium: input.version,
      protocol: input.protocolVersion,
      configSchema: input.config.schemaVersion,
      storeSchema: input.storeSchemaVersion,
      ...(input.platform ?? {}),
    },
    effectiveConfiguration: input.config,
    health,
    alerts: input.alerts,
    integrity: storeIntegrity(input.home),
    logs,
  });
  const bundle = {
    manifest,
    sections: redacted.value,
    redactionSummary: { replacements: redacted.findings },
  };
  // A diagnostic export may target the current repository or another shared directory. Protect
  // the new file, but never change the permissions of a directory Salidium does not own.
  writePrivateJsonAtomic(input.outputPath, bundle, { secureParent: false });
  return {
    path: input.outputPath,
    bytes: statSync(input.outputPath).size,
    redactions: redacted.findings,
    manifest,
  };
}
