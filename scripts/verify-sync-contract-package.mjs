/**
 * Verifies a packed `@salidium/sync-contract` the way a consumer meets it: installed on its own,
 * outside this workspace, resolved through its own export map.
 *
 * Copy this file into the directory where the tarball was installed and run it from there. The
 * copy is the point: a bare `import '@salidium/sync-contract'` resolves against the importing
 * file's location, so a script left in the repository would silently test the workspace package
 * instead of the installed one and pass no matter what shipped.
 *
 * Run it under every resolution condition the package advertises. The failure this exists to catch
 * is invisible to a single import: a condition whose target is missing from `files` installs
 * cleanly and breaks only for whichever consumer requests that condition.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  assertSendableBatch,
  DeletionReceiptV1Schema,
  ReconciliationInventoryV1Schema,
  SyncAckV1Schema,
  verifySyncOperationDigest,
} from '@salidium/sync-contract';

const OPERATION_TYPES = [
  'consent.put',
  'consent.revoke',
  'item.delete',
  'item.put',
  'scope.delete',
];

const root = './node_modules/@salidium/sync-contract';
const rootUrl = new URL(`${root}/`, import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', rootUrl), 'utf8'));

if (JSON.stringify(manifest).includes('workspace:')) {
  throw new Error('published manifest contains a workspace dependency');
}

const targets = [];
const collect = (node) => {
  if (typeof node === 'string') targets.push(node);
  else if (node && typeof node === 'object')
    for (const value of Object.values(node)) collect(value);
};
collect(manifest.exports);
if (targets.length === 0) throw new Error('published manifest advertises no exports');
for (const target of targets) {
  if (!existsSync(new URL(target, rootUrl))) {
    throw new Error(`exports target ${target} is not in the published package`);
  }
}

/*
 * Retained fixtures are the compatibility evidence for a wire version, so the released tarball has
 * to carry them and they all have to still validate. Checking one file would have missed that the
 * data lane had no frozen coverage at all.
 */
const fixtures = new URL('fixtures/v1/', rootUrl);
const names = readdirSync(fixtures).sort();
if (names.length === 0) throw new Error('no retained fixtures shipped');

const covered = new Set();
for (const name of names) {
  const value = JSON.parse(readFileSync(new URL(name, fixtures), 'utf8'));
  switch (value.contract) {
    case 'salidium.sync-batch': {
      for (const operation of assertSendableBatch(value).operations) {
        if (!verifySyncOperationDigest(operation))
          throw new Error(`${name}: digest does not verify`);
        covered.add(operation.type);
      }
      break;
    }
    case 'salidium.sync-ack':
      SyncAckV1Schema.parse(value);
      break;
    case 'salidium.deletion-receipt':
      DeletionReceiptV1Schema.parse(value);
      break;
    case 'salidium.reconciliation-inventory':
      ReconciliationInventoryV1Schema.parse(value);
      break;
    default:
      throw new Error(`${name}: unrecognized fixture contract ${value.contract}`);
  }
}

for (const type of OPERATION_TYPES) {
  if (!covered.has(type)) throw new Error(`no retained fixture covers ${type}`);
}

process.stdout.write(
  `@salidium/sync-contract@${manifest.version}: ${targets.length} export targets present, ` +
    `${names.length} retained fixtures valid, ${covered.size} operation types covered\n`,
);
