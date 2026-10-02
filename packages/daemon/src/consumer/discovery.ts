import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONSUMER_BASE_PATH,
  CONSUMER_CONTRACT,
  type ConsumerDiscovery,
  type ExperimentalContractEntry,
  ExperimentalContractEntrySchema,
} from '@salidium/consumer-contract';
import type { ProviderId } from '@salidium/protocol';
import { writePrivateJsonAtomic } from '../operations/files.ts';

/**
 * `$SALIDIUM_HOME/consumer.json`: where a consumer finds the port and contract version without
 * reading `daemon.json`, which holds the owner token. It contains no secret.
 *
 * It lives beside `daemon.json` in the owner-only state directory, so it is exactly as readable as
 * the rest of the user's Salidium state, and it is removed when the daemon that wrote it stops.
 */
export const CONSUMER_DISCOVERY_FILE = 'consumer.json';

export function consumerDiscoveryPath(home: string): string {
  return join(home, CONSUMER_DISCOVERY_FILE);
}

export function consumerDiscovery(options: {
  port: number;
  /** The providers this instance launched with. Fixed for its life: a change needs a restart. */
  providers: readonly ProviderId[];
  /** Experimental contracts this instance serves, already checked by `experimentalContracts`. */
  experimental?: readonly ExperimentalContractEntry[];
  pid: number;
  instanceId: string;
  startedAt: string;
  version: string;
  now: number;
}): ConsumerDiscovery {
  return {
    format: 'salidium.consumer-discovery',
    version: 1,
    generatedAt: new Date(options.now).toISOString(),
    // One entry per major version served. When a second major ships it is added beside this one,
    // so a client of this major keeps finding its own base URL in the same file.
    contracts: [
      {
        ...CONSUMER_CONTRACT,
        baseUrl: `http://127.0.0.1:${options.port}${CONSUMER_BASE_PATH}`,
      },
    ],
    salidium: { version: options.version },
    providers: [...new Set(options.providers)].sort().map((id) => ({ id })),
    experimental: [...(options.experimental ?? [])],
    instanceId: options.instanceId,
    pid: options.pid,
    startedAt: options.startedAt,
    authentication: {
      scheme: 'bearer',
      credential: 'consumer',
      create: 'salidium consumer create <label>',
    },
  };
}

/**
 * The experimental contract entries discovery may carry: each one valid, one per name, sorted by
 * name, at most eight. An entry that is not valid is dropped and reported, rather than making the
 * whole discovery document invalid for every consumer.
 */
export function experimentalContracts(
  entries: readonly unknown[],
  onInvalid: (reason: string) => void = () => {},
): ExperimentalContractEntry[] {
  const byName = new Map<string, ExperimentalContractEntry>();
  for (const entry of entries) {
    const parsed = ExperimentalContractEntrySchema.safeParse(entry);
    if (!parsed.success) {
      onInvalid('experimental contract entry is not valid; it is not listed');
      continue;
    }
    if (byName.has(parsed.data.name)) {
      onInvalid(`experimental contract ${parsed.data.name} is listed more than once`);
      continue;
    }
    byName.set(parsed.data.name, parsed.data);
  }
  const sorted = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
  if (sorted.length > 8)
    onInvalid('more than eight experimental contracts; the rest are not listed');
  return sorted.slice(0, 8);
}

export function writeConsumerDiscovery(home: string, discovery: ConsumerDiscovery): void {
  writePrivateJsonAtomic(consumerDiscoveryPath(home), discovery);
}

/** Removes the file only if this process wrote it, so a stopping daemon never erases a successor's. */
export function removeConsumerDiscovery(home: string, pid: number): void {
  const path = consumerDiscoveryPath(home);
  try {
    if (!existsSync(path)) return;
    const current = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown };
    if (current.pid === pid) unlinkSync(path);
  } catch {
    /* A damaged file is replaced by the next start. */
  }
}
