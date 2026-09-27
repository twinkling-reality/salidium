import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONSUMER_BASE_PATH,
  CONSUMER_CONTRACT,
  type ConsumerDiscovery,
} from '@salidium/consumer-contract';
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
