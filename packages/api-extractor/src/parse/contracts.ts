import type {
  BackendCompilerOperations,
  BackendNodeReference,
  BackendSymbolHandle,
  BackendTypeHandle,
  BackendWarningFact,
} from "../backend/contracts.ts";
import type { SemanticType } from "../model.ts";
import type { ExtractorOptions } from "../options.ts";
import type { ProvenanceEntry } from "../provenance.ts";
import type { ExternalTypeSelection } from "./external-type-selection.ts";

/**
 * Extraction options after defaults and the external-type selection are parsed
 * once at the extraction entry. The session and the resolver share this value.
 */
export type ResolvedExtractorOptions = {
  readonly shouldInclude?: ExtractorOptions["shouldInclude"];
  readonly shouldResolveObject: NonNullable<ExtractorOptions["shouldResolveObject"]>;
  readonly externalTypes: ExternalTypeSelection;
};

/** Resolver state shared by the synchronous semantic resolver modules. */
export type ResolverContext = {
  readonly operations: BackendCompilerOperations;
  readonly filePath: string;
  readonly warnings: BackendWarningFact[];
  readonly provenance: ProvenanceEntry[];
  /** Structural path in the final semantic model; never use diagnostics here. */
  readonly provenancePath: readonly string[];
  /** Selects the final collection shape for properties at the current node. */
  readonly provenancePropertyContainer: "object" | "componentProps";
  readonly symbolStack: readonly string[];
  readonly options: Pick<ResolvedExtractorOptions, "shouldInclude" | "shouldResolveObject">;
  readonly externalTypes: ExternalTypeSelection;
  readonly substitutions: ReadonlyMap<BackendSymbolHandle, BackendTypeHandle>;
  readonly active: ReadonlySet<BackendTypeHandle>;
  readonly propertyDepth: number;
  /**
   * True while resolving a member of an authored compound: an intersection
   * member or a container element. An anonymous object there is structure to
   * describe, not the module-value fallback the export root itself takes.
   */
  readonly compoundMember: boolean;
  /** Defaults authored in an object-binding parameter, keyed by public property name. */
  readonly bindingDefaults?: ReadonlyMap<string, string>;
  /** Namespaces inherited only while descending into checker-generated type arguments. */
  readonly generatedTypeArgumentNamespaces?: readonly string[];
};

/**
 * The location fields every resolver warning carries: the declaration's own
 * position when one is known, otherwise the module being extracted, plus the
 * resolver's symbol breadcrumb rooted at that module.
 */
export function warningLocation(
  context: ResolverContext,
  declaration: BackendNodeReference | undefined
): Pick<BackendWarningFact, "filePath" | "line" | "column" | "parsedSymbolStack"> {
  const location = declaration === undefined ? undefined : context.operations.nodeFacts(declaration);
  return {
    filePath: location?.filePath ?? context.filePath,
    line: location?.line ?? 1,
    column: location?.column ?? 1,
    parsedSymbolStack: [context.filePath, ...context.symbolStack],
  };
}

/**
 * Resolves one checker type, its authored syntax, and its symbol into a semantic node.
 * Threaded through the resolver modules so every recursive resolution shares one entry point.
 */
export type ResolveSemanticType = (
  type: BackendTypeHandle | undefined,
  sourceNode: BackendNodeReference | undefined,
  symbol: BackendSymbolHandle | undefined,
  context: ResolverContext
) => SemanticType;
