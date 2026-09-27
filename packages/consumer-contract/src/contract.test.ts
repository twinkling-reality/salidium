import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

const fixtures = readdirSync(fixtureDir)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => ({
    file,
    value: JSON.parse(readFileSync(new URL(file, fixtureDir), 'utf8')) as Record<string, unknown>,
  }));

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
    const report = fixtures.find(({ file }) => file === 'session-report-verified.json')?.value;
    const validator = z.fromJSONSchema(committedSchema('session-report'));
    const extended = {
      ...report,
      addedLater: true,
      session: { ...(report?.session as object), addedLater: 'x' },
    };
    expect(validator.safeParse(extended).success).toBe(true);
  });

  it('accepts discovery that also lists a later major or another contract', () => {
    const discovery = fixtures.find(({ file }) => file === 'consumer-discovery.json')?.value;
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
    const report = fixtures.find(({ file }) => file === 'session-report-failing.json')?.value;
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
  it('cover every document and every feed message type', () => {
    const formats = new Set(fixtures.map(({ value }) => documentName(value)));
    expect([...formats].sort()).toEqual([...names].sort());
    const feedTypes = new Set(
      fixtures
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
   * consumer keeps working" means. Before the first publication there is nothing released to hold
   * the code to, and this says so rather than passing silently.
   */
  const releasedRoot = new URL('released/', schemaDir);
  const released = existsSync(fileURLToPath(releasedRoot))
    ? readdirSync(releasedRoot).map((version) => new URL(`${version}/`, releasedRoot))
    : [];
  it.skipIf(released.length === 0)(
    'current fixtures validate against every released minor version of major 1',
    () => {
      for (const dir of released)
        for (const { value } of fixtures) {
          const validator = z.fromJSONSchema(committedSchema(documentName(value), dir));
          expect(validator.safeParse(value).success).toBe(true);
        }
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
