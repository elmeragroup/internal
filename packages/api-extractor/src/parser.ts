import type { BackendExtractionSession, BackendModuleDraft } from "./backend/contracts.ts";
import { applyTypeOnlyStarFilter } from "./backend/type-only-star-filter.ts";
import type { ExtractorOptions } from "./options.ts";
import { resolveModule } from "./parse/resolver.ts";
import type { ResolvedModule } from "./parse/resolver.ts";

/**
 * Backend-neutral module policy and resolver entry point.
 *
 * The adapter supplies a module descriptor and opaque compiler graph. This
 * module owns type resolution, alias/mapped substitution, warnings, and the
 * React component transform. A replacement compiler therefore only needs to
 * implement the package-owned operations in `BackendCompilerOperations`.
 */
export function parseModule(
  session: BackendExtractionSession,
  filePath: string,
  options?: ExtractorOptions
): ResolvedModule {
  const draft = readModuleDraft(session, filePath);
  return resolveModuleDraft(session, draft, filePath, options);
}

/**
 * Performs only compiler-adapter discovery. Keeping this operation separate
 * lets the Effect shell classify adapter failures independently from resolver
 * policy and user callbacks.
 */
export function readModuleDraft(session: BackendExtractionSession, filePath: string): BackendModuleDraft {
  return session.readModule(filePath);
}

/**
 * Apply module re-export policy and then invoke the compiler-free resolver.
 *
 * Type-only star re-exports keep only their pure types; structured module-walk
 * warnings flow into the extraction result beside resolver warnings.
 */
export function resolveModuleDraft(
  session: BackendExtractionSession,
  draft: BackendModuleDraft,
  filePath: string,
  options?: ExtractorOptions
): ResolvedModule {
  return resolveModule(session, filterModuleDraft(session, draft, filePath), filePath, options);
}

/**
 * Resolves the draft's type-only star sources through the adapter's own module
 * resolution and delegates the filter itself to the backend-owned
 * `applyTypeOnlyStarFilter`. The TS7 walk has already applied that filter
 * before descriptor expansion, so this pass is a no-op for it; a replacement
 * backend that hands over unfiltered drafts through the public seam still gets
 * the same policy (`extractor.test.ts` "keeps the public extraction seam
 * backend-neutral"; `boundary.test.ts` "runs parser policy against a
 * replacement backend with no compiler dependency").
 */
function filterModuleDraft(
  session: BackendExtractionSession,
  draft: BackendModuleDraft,
  filePath: string
): BackendModuleDraft {
  const typeOnlySources = new Set(
    (draft.typeOnlyStarExports ?? [])
      .map((specifier) => session.resolveModule(specifier, filePath)?.filePath)
      .filter((path): path is string => path !== undefined)
  );
  return { ...draft, exports: applyTypeOnlyStarFilter(draft.exports, typeOnlySources) };
}
