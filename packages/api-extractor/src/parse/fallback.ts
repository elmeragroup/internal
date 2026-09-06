import type {
  BackendNodeReference,
  BackendSymbolHandle,
  BackendTypeFacts,
  BackendTypeHandle,
  BackendWarningFact,
} from "../backend/contracts.ts";
import type { SemanticType } from "../model.ts";
import type { ExtractWarning, TypeFlagName } from "../warnings.ts";
import type { ResolverContext } from "./contracts.ts";
import { warningLocation } from "./contracts.ts";

type FallbackWarning = Omit<
  Extract<BackendWarningFact, { readonly code: "unsupported-type-fallback" }>,
  "sourceText"
> & {
  sourceText?: string;
};

export function warningMessage(warning: BackendWarningFact): ExtractWarning {
  if (warning.code === "missing-enum-declaration") {
    return {
      ...warning,
      message: `Could not resolve enum "${warning.enumName}"${warning.memberName === undefined ? "" : ` member "${warning.memberName}"`} at "${warning.filePath}:${warning.line}:${warning.column}". The extractor omitted it. Check that the enum declaration is included in the configured TypeScript project.`,
    };
  }
  if (warning.code === "missing-default-export-symbol") {
    return {
      ...warning,
      message: `Could not resolve default export "${warning.sourceText}" to a symbol at "${warning.filePath}:${warning.line}:${warning.column}". The extractor skipped it. Name the declaration before exporting it if it must appear in the API.`,
    };
  }
  if (warning.code === "unresolved-re-export") {
    const reasonText =
      warning.reason === "cycle"
        ? "following the re-export chain returned to its starting namespace"
        : warning.reason === "ambiguous"
          ? "more than one starred module exports the same name and TypeScript excludes ambiguous star re-exports"
          : "the re-export target could not be resolved";
    return {
      ...warning,
      message: `Could not resolve re-export "${warning.name}" at "${warning.filePath}:${warning.line}:${warning.column}" because ${reasonText}. The extractor skipped it. Check the export chain if it must appear in the API.`,
    };
  }
  if (warning.code === "omitted-index-signature") {
    return {
      ...warning,
      message:
        warning.reason === "additional-signature"
          ? `The type at "${warning.filePath}:${warning.line}:${warning.column}" has more than one index signature, but the output model supports one. The extractor omitted the signature with key type "${warning.keyTypes.join(" | ")}". Review the generated API if both signatures matter.`
          : `The index signature at "${warning.filePath}:${warning.line}:${warning.column}" uses unsupported key type "${warning.keyTypes.join(" | ")}". The extractor omitted it. Change the key type or review the generated API.`,
    };
  }
  if (warning.code === "unrepresented-construct-signatures") {
    return {
      ...warning,
      message: `The non-class shape at "${warning.filePath}:${warning.line}:${warning.column}" has ${warning.signatureCount} construct signature${warning.signatureCount === 1 ? "" : "s"} at ${warning.structuralPath.join("/")}, which the output model cannot represent. The extractor omitted ${warning.signatureCount === 1 ? "it" : "them"}. Use a class declaration or review the generated API.`,
    };
  }
  if (warning.code === "omitted-callable-members") {
    return {
      ...warning,
      message: `The callable shape at "${warning.filePath}:${warning.line}:${warning.column}" also has named members ${warning.memberNames.map((name) => `"${name}"`).join(", ")} at ${warning.structuralPath.join("/")}, which the output model cannot represent beside a call signature. The extractor omitted those members. Model them separately or review the generated API.`,
    };
  }
  if (warning.code === "uncertain-component-recognition") {
    return {
      ...warning,
      message: `Could not classify "${warning.name}" as a React component at "${warning.filePath}:${warning.line}:${warning.column}" because part of its union returns a non-React value. The extractor kept the original union type. Review the export if it should be a component.`,
    };
  }
  const resolvingText =
    warning.sourceText !== undefined && warning.sourceText !== warning.typeText
      ? ` while resolving "${warning.sourceText}"`
      : "";
  return {
    ...warning,
    message: `Could not extract type "${warning.typeText}"${resolvingText} at "${warning.filePath}:${warning.line}:${warning.column}". The extractor used any. Review this API or add support for this type.`,
  };
}

/** Prefer the authored node when locating and describing an unsupported type. */
export function unsupported(
  context: ResolverContext,
  type: BackendTypeHandle | undefined,
  symbol: BackendSymbolHandle | undefined,
  sourceNode: BackendNodeReference | undefined
): SemanticType {
  const facts: BackendTypeFacts | undefined =
    type === undefined ? undefined : context.operations.typeFacts(type);
  const symbolInfo = symbol === undefined ? undefined : context.operations.symbolFacts(symbol);
  const locationNode = sourceNode ?? symbolInfo?.declarations[0];
  const fallbackFlags: readonly TypeFlagName[] = ["Other"];
  const warning: FallbackWarning = {
    code: "unsupported-type-fallback" as const,
    ...warningLocation(context, locationNode),
    typeFlags: facts?.flags ?? fallbackFlags,
    typeText: type === undefined ? "<missing type>" : context.operations.typeToString(type),
  };
  const sourceText = sourceNode === undefined ? undefined : context.operations.nodeFacts(sourceNode).text;
  if (sourceText !== undefined) warning.sourceText = sourceText;
  context.warnings.push(warning);
  return { kind: "intrinsic", intrinsic: "any" };
}
