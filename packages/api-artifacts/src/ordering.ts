/**
 * Compares strings by UTF-16 code unit order, as the `<` and `>` operators do.
 *
 * Artifact JSON is compared byte-for-byte in check mode, so every sort that
 * feeds generated output must be independent of the host locale. Default
 * `Array.prototype.sort` order and this comparator agree.
 *
 * @param left - The left string.
 * @param right - The right string.
 * @returns A negative number, zero, or a positive number as `left` sorts before, with, or after `right`.
 */
export function compareUtf16CodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
