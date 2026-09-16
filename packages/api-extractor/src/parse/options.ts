import { definedFields } from "../optional-fields.ts";
import { defaultExtractorOptions } from "../options.ts";
import type { ExtractorOptions } from "../options.ts";
import type { ResolvedExtractorOptions } from "./contracts.ts";
import { normalizeExternalTypeSelection } from "./external-type-selection.ts";

/**
 * Parses public extractor options once at the extraction entry: fills the
 * documented defaults and copies the mutable external-type selection into a
 * stable policy value. The backend session and the resolver share the result,
 * so neither re-reads or re-normalizes the caller's options.
 *
 * @param options - The caller's options, or `undefined` for every default.
 * @returns The resolved options every inner layer consumes.
 */
export function parseExtractorOptions(options?: ExtractorOptions): ResolvedExtractorOptions {
  return {
    ...definedFields({ shouldInclude: options?.shouldInclude }),
    shouldResolveObject: options?.shouldResolveObject ?? defaultExtractorOptions.shouldResolveObject,
    externalTypes: normalizeExternalTypeSelection(
      options?.includeExternalTypes ?? defaultExtractorOptions.includeExternalTypes
    ),
  };
}
