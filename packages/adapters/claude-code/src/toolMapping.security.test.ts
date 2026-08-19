import { describe, expect, it } from 'vitest';
import { mapToolInput } from './toolMapping.ts';

describe('MCP path metadata', () => {
  it('captures a sensitive path before the display excerpt is truncated', () => {
    const mapped = mapToolInput('mcp__filesystem__read_file', {
      padding: 'x'.repeat(400),
      path: '/repo/.env.production',
    });

    expect(mapped.input).toMatchObject({
      kind: 'mcp',
      pathArgs: ['/repo/.env.production'],
    });
    if (mapped.input.kind !== 'mcp') throw new Error('expected MCP input');
    expect(mapped.input.argsExcerpt).not.toContain('.env.production');
  });
});
