import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CONSUMER_CONTRACT,
  CONSUMER_DOCUMENTS,
  type ConsumerDocumentName,
  consumerJsonSchema,
  consumerJsonSchemaText,
  FeedMessageSchema,
  readFeedMessage,
} from './index.ts';

const packageRoot = new URL('../', import.meta.url);
const schemaDir = new URL('schema/v1/', packageRoot);
const fixtureDir = new URL('fixtures/v1/', packageRoot);
const names = Object.keys(CONSUMER_DOCUMENTS) as ConsumerDocumentName[];

function committedSchema(name: string, dir: URL = schemaDir): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`${name}.schema.json`, dir), 'utf8'));
}

function documentName(value: { format?: unknown }): ConsumerDocumentName {
  const name = String(value.format).replace(/^salidium\./, '');
  if (!names.includes(name as ConsumerDocumentName)) throw new Error(`unknown format ${name}`);
  return name as ConsumerDocumentName;
}

/*
 * Retained fixtures, one set per minor version. 1.0's were published at `fixtures/v1/*.json` and
 * stay there; every later minor's sit in `fixtures/v1/<major.minor>/`. The current minor's set
 * describes what the code emits now; an older set is evidence about what that version emitted.
 */
const CURRENT = `${CONSUMER_CONTRACT.major}.${CONSUMER_CONTRACT.minor}`;
const minorOf = (version: string) => Number(version.split('.')[1]);

function fixtureSet(version: string) {
  const dir = version === '1.0' ? fixtureDir : new URL(`${version}/`, fixtureDir);
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({
      file: version === '1.0' ? file : `${version}/${file}`,
      value: JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as Record<string, unknown>,
    }));
}

const fixtureVersions = [
  '1.0',
  ...readdirSync(fixtureDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name),
].sort((left, right) => minorOf(left) - minorOf(right));
const fixtures = fixtureVersions.includes(CURRENT) ? fixtureSet(CURRENT) : [];
/** A current fixture by its name within the set. */
function fixture(name: string): Record<string, unknown> | undefined {
  return fixtures.find(({ file }) => file.split('/').at(-1) === name)?.value;
}
const olderFixtures = fixtureVersions
  .filter((version) => version !== CURRENT)
  .map((version) => ({ version, fixtures: fixtureSet(version) }));

describe('JSON Schema', () => {
  it.each(names)('schema/v1/%s.schema.json is exactly what the zod source generates', (name) => {
    const committed = readFileSync(new URL(`${name}.schema.json`, schemaDir), 'utf8');
    // Regenerate with `node scripts/write-consumer-contract.mjs --schema`, then review the diff:
    // within a major version it may only add.
    expect(committed).toBe(consumerJsonSchemaText(name));
  });

  it('names every document by its contract major version', () => {
    for (const name of names)
      expect(consumerJsonSchema(name).$id).toBe(
        `urn:salidium:consumer:${CONSUMER_CONTRACT.major}:${name}`,
      );
  });

  it('leaves objects open, so an older consumer accepts a newer minor version', () => {
    const report = fixture('session-report-verified.json');
    const validator = z.fromJSONSchema(committedSchema('session-report'));
    const extended = {
      ...report,
      addedLater: true,
      session: { ...(report?.session as object), addedLater: 'x' },
    };
    expect(validator.safeParse(extended).success).toBe(true);
  });

  it('accepts discovery that also lists a later major or another contract', () => {
    const discovery = fixture('consumer-discovery.json');
    const entries = discovery?.contracts as Array<Record<string, unknown>>;
    const validator = z.fromJSONSchema(committedSchema('consumer-discovery'));
    const later = {
      ...discovery,
      contracts: [
        ...entries,
        { ...entries[0], major: 2, minor: 0, baseUrl: 'http://127.0.0.1:47822/consumer/v2' },
        {
          name: 'salidium.something-else',
          major: 1,
          minor: 3,
          baseUrl: 'http://127.0.0.1:47822/consumer/v1',
          extra: true,
        },
      ],
    };
    expect(validator.safeParse(later).success).toBe(true);
  });

  it('still rejects a missing property, a wrong type, and an unknown enumeration value', () => {
    const report = fixture('session-report-failing.json');
    const validator = z.fromJSONSchema(committedSchema('session-report'));
    const { verdict: _verdict, ...withoutVerdict } = report ?? {};
    expect(validator.safeParse(withoutVerdict).success).toBe(false);
    expect(validator.safeParse({ ...report, version: 1 }).success).toBe(false);
    expect(
      validator.safeParse({
        ...report,
        session: { ...(report?.session as object), status: 'paused' },
      }).success,
    ).toBe(false);
    expect(
      validator.safeParse({
        ...report,
        session: { ...(report?.session as object), title: undefined },
      }).success,
    ).toBe(false);
  });
});

describe('retained fixtures', () => {
  it('hold a set for the current minor version and for every one before it', () => {
    expect(fixtureVersions).toEqual(
      Array.from(
        { length: CONSUMER_CONTRACT.minor + 1 },
        (_, minor) => `${CONSUMER_CONTRACT.major}.${minor}`,
      ),
    );
  });

  it.each(fixtureVersions)('%s covers every document and every feed message type', (version) => {
    const set = fixtureSet(version);
    const formats = new Set(set.map(({ value }) => documentName(value)));
    expect([...formats].sort()).toEqual([...names].sort());
    const feedTypes = new Set(
      set
        .filter(({ value }) => value.format === 'salidium.session-feed')
        .map(({ value }) => value.type),
    );
    expect([...feedTypes].sort()).toEqual(
      FeedMessageSchema.options.map((option) => option.shape.type.value).sort(),
    );
  });

  it.each(fixtures)('$file is exactly a valid document under the zod source', ({ value }) => {
    // Parsing drops undeclared properties, so equality means nothing is missing or extra.
    expect(CONSUMER_DOCUMENTS[documentName(value)].parse(value)).toEqual(value);
  });

  it.each(fixtures)('$file validates against the committed JSON Schema itself', ({ value }) => {
    // Rebuilt from the file on disk, not from zod: this is the check a non-TypeScript consumer
    // relies on when it validates with the schema alone.
    const validator = z.fromJSONSchema(committedSchema(documentName(value)));
    expect(validator.safeParse(value).success).toBe(true);
  });

  /*
   * The additive rule, enforced. Once a minor version is published its schemas are copied, never
   * edited, into `schema/v1/released/<major.minor>/` (docs/releasing.md). Every document the
   * current code describes must still validate against each of them, which is what "an older
   * consumer keeps working" means. Wire 1.0 is frozen, so there is always at least one.
   */
  const releasedRoot = new URL('released/', schemaDir);
  const released = readdirSync(releasedRoot)
    .sort()
    .map((version) => ({ version, dir: new URL(`${version}/`, releasedRoot) }));

  it('holds a complete released copy of every published minor version, starting with 1.0', () => {
    expect(released.map(({ version }) => version)).toContain('1.0');
    for (const { version, dir } of released) {
      expect(version).toMatch(new RegExp(`^${CONSUMER_CONTRACT.major}\\.\\d+$`));
      // A copy missing a document would let that document drift unchecked.
      expect(readdirSync(dir).sort()).toEqual(names.map((name) => `${name}.schema.json`).sort());
    }
  });

  it.each(released)(
    'current fixtures validate against the released $version schemas',
    ({ dir }) => {
      for (const { file, value } of fixtures) {
        const validator = z.fromJSONSchema(committedSchema(documentName(value), dir));
        expect(validator.safeParse(value).success, file).toBe(true);
      }
    },
  );

  /*
   * An older minor's fixtures are not documents of the current minor, which adds required
   * properties, so they are held to what they always were: their own version's released schemas.
   */
  it.each(olderFixtures)(
    '$version fixtures still validate against their own released schemas',
    ({ version, fixtures: set }) => {
      const dir = new URL(`${version}/`, releasedRoot);
      for (const { file, value } of set) {
        const validator = z.fromJSONSchema(committedSchema(documentName(value), dir));
        expect(validator.safeParse(value).success, file).toBe(true);
      }
    },
  );

  /*
   * Fixtures are write-once from publication: they testify about what a released version served,
   * so a fixture edited afterwards would testify about nothing. These are the bytes published in
   * `@salidium/consumer-contract@1.0.0` (identical to `1.0.0-rc.0`). Changing one of them, or this
   * list, is a change to released evidence and needs a reason a reviewer can see.
   */
  const RELEASED_FIXTURES_1_0: Record<string, string> = {
    'consumer-discovery.json': '819bd55330bb1eef552d2c4a5d876271356fb74ea559f8bdc135d1152f847d5e',
    'consumer-error-session-not-observed.json':
      'f31c050a650e111e847271fe1af272231787a5c39d9ae5ed3a7cdd9957cbe0a8',
    'consumer-error-unauthorized.json':
      '8f747fcd5f9e3ffcd720c10f016165b481dcc994f30bf19bbcf7650d7d4750d6',
    'session-feed-closing.json': '7ab6b205e72b574b37c822b46fec4358844ded74db855f54b2e2825d45915f0f',
    'session-feed-heartbeat.json':
      'd65965476e3184a8057e7ad5b86a6b86dffb49b2c43400e52d74fa0f6d24062e',
    'session-feed-resync.json': '35bd6e7b681099e196653e5c2866452b678d1aee8606412ea13a588f86e54022',
    'session-feed-session-changed.json':
      '4d46bfe4c2a3c9ee75ad994d1c4339ccaf235fe73e44f01514327deb6d17f56c',
    'session-feed-session-removed.json':
      '9ee2d78035aadff1daae449e3fff24eb6907e9b1dab761d5007b1fb32f593eba',
    'session-list.json': 'a4145ee4bec10d2df9ea4cd19f247be367c81843c9f055c5eeb9f657dd0d98e3',
    'session-lookup.json': '96f1855126726de0f54c1a92eb46faf39fefc4ee0db10c04a8eec401c2bf11fc',
    'session-report-failing.json':
      '22c33d668a3b09694e72107ec22810b560470aee96d6e1bb1be7eb614334a193',
    'session-report-verified.json':
      '1de7741f6789640b12345190caff6d8d2fc57aaee9bf836c2fd4ec9dcfa4042a',
    'session-report-working.json':
      '93da7ff2d8a40defc952e650ea29d59fcfda1779bf54740f8d43f4ad0630c1ef',
  };

  it.each(Object.entries(RELEASED_FIXTURES_1_0))(
    '%s is still the fixture published with 1.0',
    (file, sha256) => {
      const bytes = readFileSync(new URL(file, fixtureDir));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
    },
  );

  /** The bytes published in `@salidium/consumer-contract@1.1.0`, under the same rule. */
  const RELEASED_FIXTURES_1_1: Record<string, string> = {
    'consumer-discovery.json': '3c4ce2d67b85ece97f61dbd70abfb63a207e8aae7788448b2998219ccc7e9923',
    'consumer-error-session-not-observed.json':
      'f31c050a650e111e847271fe1af272231787a5c39d9ae5ed3a7cdd9957cbe0a8',
    'consumer-error-unauthorized.json':
      '8f747fcd5f9e3ffcd720c10f016165b481dcc994f30bf19bbcf7650d7d4750d6',
    'session-feed-closing.json': '7ab6b205e72b574b37c822b46fec4358844ded74db855f54b2e2825d45915f0f',
    'session-feed-heartbeat.json':
      'd65965476e3184a8057e7ad5b86a6b86dffb49b2c43400e52d74fa0f6d24062e',
    'session-feed-resync.json': '35bd6e7b681099e196653e5c2866452b678d1aee8606412ea13a588f86e54022',
    'session-feed-session-changed.json':
      '98a7cdca73af22c6613b69438bb68ea583a3d9e740b3ff772974714a6092cd05',
    'session-feed-session-removed.json':
      '9ee2d78035aadff1daae449e3fff24eb6907e9b1dab761d5007b1fb32f593eba',
    'session-list.json': 'fbfc7d4f00f3189f7fdb30647f5ebc907afcb577095184da77f3473849b19d30',
    'session-lookup.json': 'a02ae0fb45f83a20685ad80eaaf9257d690954572c217dbdee682141dfb60f2d',
    'session-report-failing.json':
      '23ed53cb5970d44c82a9083ee3b52417cc59595ef89f744715980cf5ee60e22f',
    'session-report-verified.json':
      'e44d39c508a7122e6d90e095de80818bc23efde8995241c365ccca1bfbfc7e53',
    'session-report-working.json':
      '41dc43b26c2ac1a97613f40209c9a0cc235e97481b2d04828c6d70a8f9e3f7a0',
  };

  it('pins every 1.1 fixture, so none can be added or changed after publication unseen', () => {
    expect(
      readdirSync(new URL('1.1/', fixtureDir))
        .filter((f) => f.endsWith('.json'))
        .sort(),
    ).toEqual(Object.keys(RELEASED_FIXTURES_1_1).sort());
  });

  it.each(Object.entries(RELEASED_FIXTURES_1_1))(
    '%s is still the fixture published with 1.1',
    (file, sha256) => {
      const bytes = readFileSync(new URL(`1.1/${file}`, fixtureDir));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
    },
  );
});

describe('reading the feed', () => {
  it('skips a message type this version does not know, as the compatibility rules require', () => {
    expect(
      readFeedMessage(
        JSON.stringify({ format: 'salidium.session-feed', version: 1, type: 'future.thing' }),
      ),
    ).toBeNull();
  });

  it('rejects a known message type that is malformed', () => {
    expect(() =>
      readFeedMessage({ format: 'salidium.session-feed', version: 1, type: 'resync' }),
    ).toThrow();
  });
});
