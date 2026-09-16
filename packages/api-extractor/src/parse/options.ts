import { defaultExtractorOptions } from "../options.ts";
import type { ExtractorOptions } from "../options.ts";
import { normalizeExternalTypeSelection } from "./external-type-selection.ts";
import type { ExternalTypeSelection } from "./external-type-selection.ts";

/**
 * Extraction options after defaults and the external-type selection are parsed
 * once at the extraction entry. The session and the resolver share this value.
 *
 * This type stays parse-internal on purpose: it exposes the backend-facing
 * external-type selection, which must not join the public declaration graph.
 */
export type ResolvedExtractorOptions = {
  readonly shouldInclude: ExtractorOptions["shouldInclude"] | undefined;
  readonly shouldResolveObject: NonNullable<ExtractorOptions["shouldResolveObject"]>;
  readonly externalTypes: ExternalTypeSelection;
};

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
    shouldInclude: options?.shouldInclude,
    shouldResolveObject: options?.shouldResolveObject ?? defaultExtractorOptions.shouldResolveObject,
    externalTypes: normalizeExternalTypeSelection(
      options?.includeExternalTypes ?? defaultExtractorOptions.includeExternalTypes
    ),
  };
}
