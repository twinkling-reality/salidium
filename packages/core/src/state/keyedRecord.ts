/**
 * Reads and writes for records keyed by provider data: call ids, paths, agent ids and lanes.
 *
 * A provider names its calls and files, so a key can be `constructor`, `toString` or `__proto__`.
 * `reviveState` gives the state's records no prototype, but a state can still arrive without
 * passing through it (a replay read straight off the wire, a test fixture), so lookups do not rely
 * on that: only an own entry counts, and an entry is defined rather than assigned, so `__proto__`
 * is recorded instead of replacing the record's prototype.
 */
export function ownEntry<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function setEntry<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
