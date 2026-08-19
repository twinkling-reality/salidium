import { describe, expect, it } from 'vitest';
import { historyAriaRowCount, historyAriaRowIndex } from './historyAria.ts';

describe('History table accessibility row metadata', () => {
  it('counts the header and gives virtualized data rows distinct one-based positions', () => {
    expect(historyAriaRowCount(0)).toBe(1);
    expect(historyAriaRowCount(25)).toBe(26);
    expect(historyAriaRowIndex(0)).toBe(2);
    expect(historyAriaRowIndex(24)).toBe(26);
  });
});
