import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertSendableBatch } from './wire.ts';

describe('published v1 fixture', () => {
  it('remains valid and digest-verified', () => {
    const path = fileURLToPath(new URL('../fixtures/v1/control-batch.json', import.meta.url));
    const fixture: unknown = JSON.parse(readFileSync(path, 'utf8'));
    expect(assertSendableBatch(fixture).operations.map((operation) => operation.type)).toEqual([
      'consent.put',
    ]);
  });
});
