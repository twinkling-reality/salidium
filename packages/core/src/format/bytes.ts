/**
 * One byte rendering for every surface, in the units the operating system uses.
 *
 * There were three: `packages/cli/src/main.ts` and `packages/ui/src/components/IngestStorage.tsx`
 * held identical binary copies, and `SalidiumMenuBar.swift` used `ByteCountFormatter` with `.file`,
 * which is decimal. The same store read at the same instant was "2.53 GiB" in the app and "2.71 GB"
 * in the menu bar, so a reader who checked both saw two sizes for one number and had no way to tell
 * which was wrong.
 *
 * Decimal, and spelled GB, because the question this answers is "how much space is Salidium using"
 * and the reader checks that in Finder. Get Info reports the store at 2.72 GB. Resolving the two
 * Salidium surfaces to a binary number they agree on would have left all three disagreeing with the
 * operating system, which is the same fault one level out. Precision is fixed here rather than
 * delegated to `ByteCountFormatter`, whose adaptive mode renders one byte as "0 KB" and 999999 as
 * "1 MB"; this also formats rates, where that loses the value entirely.
 *
 * The Swift file cannot import this, so `byteLabelVectors` pins what it has to agree with and
 * `macosService.test.ts` checks it.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(1)} KB`;
  if (bytes < 1000 * 1000 * 1000) return `${(bytes / (1000 * 1000)).toFixed(1)} MB`;
  return `${(bytes / (1000 * 1000 * 1000)).toFixed(2)} GB`;
}

/** Cases the Swift menu bar has to reproduce exactly. Read by a test, not by the product. */
export const byteLabelVectors: ReadonlyArray<readonly [number, string]> = [
  [0, '0 B'],
  [999, '999 B'],
  [1000, '1.0 KB'],
  [999_999, '1000.0 KB'],
  [1_000_000, '1.0 MB'],
  [999_999_999, '1000.0 MB'],
  [1_000_000_000, '1.00 GB'],
  // The store on the machine this was written against. Finder's Get Info agrees, to the digit.
  [2_720_022_528, '2.72 GB'],
];
