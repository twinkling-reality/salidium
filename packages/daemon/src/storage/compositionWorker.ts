import { parentPort, workerData } from 'node:worker_threads';
import { SqliteStore } from './sqliteStore.ts';

/*
 * Measuring what the store is made of, on a worker that belongs to this package.
 *
 * There are two ways the daemon can reach a worker and it needs both. Packaged, it is one bundled
 * file and the only entry point that exists is the CLI, so the measurement is reached through a
 * private `__storage-composition` subcommand of it. Embedded, which is how `startDaemon` is used by
 * the end-to-end fixture and by anything else that imports this package, there is no CLI at all:
 * `process.argv[1]` is whatever started the host process, and spawning that as a worker runs the
 * host's own entry point again. That is what happened here first, and it surfaced to the reader as
 * "the measurement produced no result", which is true and useless.
 *
 * This file is the embedded half. It exists beside the compiled daemon and not inside the bundle,
 * so its presence is exactly the condition that distinguishes the two cases.
 */
const path = typeof workerData === 'string' ? workerData : undefined;
if (!path) throw new Error('storage composition worker needs a store path');

const store = new SqliteStore(path, { concurrentWriter: true });
try {
  parentPort?.postMessage(store.storageComposition());
} finally {
  store.close();
}
