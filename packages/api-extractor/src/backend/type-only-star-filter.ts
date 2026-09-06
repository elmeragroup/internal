import type { BackendExportDraft } from "./contracts.ts";

/**
 * Drops every draft whose ORIGINAL declaration sits in a type-only star's
 * module unless the draft is a pure type or was explicitly named by a
 * non-type-only export statement.
 *
 * The whole DESCRIPTOR GROUP of a skipped export disappears: a function whose
 * namespace merges onto it contributes member drafts that are themselves pure
 * types, but TypeScript exports none of them through `export type *`, so they
 * are removed with their owner rather than leaked as top-level names.
 *
 * Owned by the backend module walk, which applies it before descriptor
 * expansion; compiler-free so `parser.ts` can run the same policy over any
 * adapter's drafts. Applying it twice is a no-op.
 */
export function applyTypeOnlyStarFilter(
  exports: readonly BackendExportDraft[],
  typeOnlyFiles: ReadonlySet<string>
): readonly BackendExportDraft[] {
  if (typeOnlyFiles.size === 0) return exports;
  const droppedRoots = new Set<string>();
  for (const entry of exports) {
    const root = entry.symbolStack?.[0] ?? entry.name;
    if (
      !entry.name.includes(".") &&
      entry.declarationSourcePath !== undefined &&
      typeOnlyFiles.has(entry.declarationSourcePath) &&
      entry.pureType !== true &&
      entry.explicitValueReExport !== true
    ) {
      droppedRoots.add(root);
    }
  }
  if (droppedRoots.size === 0) return exports;
  return exports.filter((entry) => {
    const root = entry.symbolStack?.[0] ?? entry.name;
    return !droppedRoots.has(root);
  });
}
