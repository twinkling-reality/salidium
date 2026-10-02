/**
 * Verifies a packed `@salidium/consumer-contract` the way a consumer meets it: installed on its
 * own, outside this workspace, resolved through its own export map.
 *
 * Copy this file into the directory where the tarball was installed and run it from there, for the
 * same reason as `verify-sync-contract-package.mjs`: a bare import resolves against the importing
 * file's location, so a script left in the repository would test the workspace package instead.
 *
 * It checks the three things a consumer depends on: the runtime surface imports, every retained
 * fixture validates under the shipped zod schemas, and every retained fixture validates against the
 * shipped JSON Schema files on their own, which is what a consumer in another language uses.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  CONSUMER_CONTRACT,
  CONSUMER_DOCUMENTS,
  consumerJsonSchemaText,
} from '@salidium/consumer-contract';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const root = './node_modules/@salidium/consumer-contract';
const rootUrl = new URL(`${root}/`, import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', rootUrl), 'utf8'));

if (JSON.stringify(manifest).includes('workspace:'))
  throw new Error('published manifest contains a workspace dependency');

const targets = [];
const collect = (node) => {
  if (typeof node === 'string') targets.push(node);
  else if (node && typeof node === 'object')
    for (const value of Object.values(node)) collect(value);
};
collect(manifest.exports);
if (targets.length === 0) throw new Error('published manifest advertises no exports');
for (const target of targets.filter((target) => !target.includes('*')))
  if (!existsSync(new URL(target, rootUrl)))
    throw new Error(`exports target ${target} is not in the published package`);

const names = Object.keys(CONSUMER_DOCUMENTS);
for (const name of names) {
  // Resolved through the export map, the way a consumer asks for it.
  const path = require.resolve(`@salidium/consumer-contract/schema/v1/${name}.schema.json`);
  if (readFileSync(path, 'utf8') !== consumerJsonSchemaText(name))
    throw new Error(`shipped schema ${name} does not match the shipped runtime`);
}

/*
 * Retained fixtures come one set per minor version: 1.0's at `fixtures/v1/*.json`, every later
 * minor's in `fixtures/v1/<major.minor>/`. The current minor's set must be exactly what the shipped
 * runtime accepts and validate under the shipped schema and every released copy; an older set must
 * still validate under its own released copy, which is what it was published against.
 */
const schemaFile = (name, released) =>
  require.resolve(
    `@salidium/consumer-contract/schema/v1/${released ? `released/${released}/` : ''}${name}.schema.json`,
  );
const validates = (name, value, released) =>
  z.fromJSONSchema(JSON.parse(readFileSync(schemaFile(name, released), 'utf8'))).safeParse(value)
    .success;
const releasedVersions = readdirSync(new URL('schema/v1/released/', rootUrl));
const current = `${CONSUMER_CONTRACT.major}.${CONSUMER_CONTRACT.minor}`;
const fixtureRoot = new URL('fixtures/v1/', rootUrl);
const versions = [
  '1.0',
  ...readdirSync(fixtureRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name),
];
if (!versions.includes(current)) throw new Error(`no retained fixtures for ${current}`);
let fixtureCount = 0;
for (const version of versions) {
  const dir = version === '1.0' ? fixtureRoot : new URL(`${version}/`, fixtureRoot);
  const files = readdirSync(dir).filter((file) => file.endsWith('.json'));
  const covered = new Set();
  for (const file of files) {
    const value = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    const name = String(value.format).replace(/^salidium\./, '');
    if (!names.includes(name))
      throw new Error(`${version}/${file}: unrecognized format ${value.format}`);
    if (version === current) {
      CONSUMER_DOCUMENTS[name].parse(value);
      if (!validates(name, value)) throw new Error(`${file}: rejected by the shipped JSON Schema`);
      for (const released of releasedVersions)
        if (!validates(name, value, released))
          throw new Error(`${file}: rejected by the released ${released} JSON Schema`);
    } else if (!validates(name, value, version)) {
      throw new Error(`${version}/${file}: rejected by its own released JSON Schema`);
    }
    covered.add(name);
    fixtureCount += 1;
  }
  for (const name of names)
    if (!covered.has(name)) throw new Error(`no ${version} fixture covers ${name}`);
}

process.stdout.write(
  `@salidium/consumer-contract@${manifest.version} (contract ${CONSUMER_CONTRACT.name} ` +
    `${CONSUMER_CONTRACT.major}.${CONSUMER_CONTRACT.minor}): ${names.length} schemas match, ` +
    `${fixtureCount} retained fixtures across ${versions.length} minor versions valid\n`,
);
