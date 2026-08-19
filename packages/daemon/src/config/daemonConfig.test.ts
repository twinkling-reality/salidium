import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HISTORY_DAYS,
  resolveDaemonConfig,
  validateSalidiumHistoryDays,
} from './daemonConfig.ts';

afterEach(() => vi.unstubAllEnvs());

describe('transcript history window', () => {
  it.each([undefined, '0', '1', '7', '0007', String(Number.MAX_SAFE_INTEGER)])(
    'accepts a nonnegative whole number (%s)',
    (raw) => {
      expect(validateSalidiumHistoryDays(raw)).toBe(
        raw === undefined ? DEFAULT_HISTORY_DAYS : Number(raw),
      );
    },
  );

  it.each(['', '-1', '1.5', 'NaN', 'Infinity', '1e3', ' 7 ', String(2 ** 53)])(
    'rejects an ambiguous or unsafe value (%s)',
    (raw) => {
      expect(() => validateSalidiumHistoryDays(raw)).toThrow(/nonnegative whole number/);
    },
  );

  it('validates both environment values and programmatic overrides before startup', () => {
    vi.stubEnv('SALIDIUM_HISTORY_DAYS', 'not-a-number');
    expect(() => resolveDaemonConfig()).toThrow(/SALIDIUM_HISTORY_DAYS/);
    expect(() => resolveDaemonConfig({ historyDays: Number.NaN })).toThrow(
      /historyDays must be a nonnegative whole number/,
    );
    expect(resolveDaemonConfig({ historyDays: 0 }).historyDays).toBe(0);
  });
});
