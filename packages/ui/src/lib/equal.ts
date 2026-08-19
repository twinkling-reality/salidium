/**
 * Bounded structural equality for projection rows. `projectSession` rebuilds every row object on
 * each event batch, so `React.memo` needs a comparator that looks through the fresh wrappers
 * (rows, their arrays of sub-rows, and the objects those hold) without walking the whole
 * RunState. Functions and anything deeper than `depth` compare by identity. The default depth
 * covers props → row → sub-row array → sub-row → its arrays/objects → primitives.
 */
export function rowEqual(a: unknown, b: unknown, depth = 5): boolean {
  if (Object.is(a, b)) return true;
  if (depth === 0 || typeof a !== 'object' || typeof b !== 'object' || a === null || b === null)
    return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const k of ka) {
    if (!Object.hasOwn(rb, k) || !rowEqual(ra[k], rb[k], depth - 1)) return false;
  }
  return true;
}
