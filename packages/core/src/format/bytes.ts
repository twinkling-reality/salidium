/**
 * One byte rendering for every surface.
 *
 * There were three: `packages/cli/src/main.ts` and `packages/ui/src/components/IngestStorage.tsx`
 * held identical copies, and `SalidiumMenuBar.swift` used `ByteCountFormatter` with `.file`, which
 * is decimal. The same store read at the same instant was "2.53 GiB" in the app and "2.71 GB" in
 * the menu bar, so a reader who checked both saw two sizes for one number and had no way to tell
 * which was wrong. The Swift file cannot import this, so `byteLabelVectors` pins what it has to
 * agree with and `macosService.test.ts` checks it.
 *
 * Binary units, spelled KiB rather than KB, because that is what the value is: the alternative is
 * a label that is off by seven percent at gigabyte scale and says nothing about which convention
 * produced it.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

/** Cases the Swift menu bar has to reproduce exactly. Read by a test, not by the product. */
export const byteLabelVectors: ReadonlyArray<readonly [number, string]> = [
  [0, '0 B'],
  [1023, '1023 B'],
  [1024, '1.0 KiB'],
  [1048575, '1024.0 KiB'],
  [1048576, '1.0 MiB'],
  [1073741823, '1024.0 MiB'],
  [1073741824, '1.00 GiB'],
  [2713658480, '2.53 GiB'],
];
