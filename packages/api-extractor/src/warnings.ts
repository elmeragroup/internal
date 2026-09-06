import { Schema } from "effect";

export const typeFlagNames = [
  "Any",
  "Unknown",
  "Undefined",
  "Null",
  "Void",
  "String",
  "Number",
  "BigInt",
  "Boolean",
  "ESSymbol",
  "StringLiteral",
  "NumberLiteral",
  "BigIntLiteral",
  "BooleanLiteral",
  "UniqueESSymbol",
  "EnumLiteral",
  "Enum",
  "NonPrimitive",
  "Never",
  "TypeParameter",
  "Object",
  "Index",
  "TemplateLiteral",
  "StringMapping",
  "Substitution",
  "IndexedAccess",
  "Conditional",
  "Union",
  "Intersection",
  "Other",
] as const;

export type TypeFlagName = (typeof typeFlagNames)[number];

const WarningLocationSchema = Schema.Struct({
  message: Schema.String,
  filePath: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
  parsedSymbolStack: Schema.Array(Schema.String),
});

/**
 * Why an index signature the type declares is missing from the model.
 *
 * `unrepresentable-key` is a key domain the semantic model has no encoding for —
 * a `symbol` key, or a template-literal pattern key. `additional-signature` is a
 * key that *is* representable but lost the model's single index-signature slot,
 * which is what happens to the legal `string` plus `number` pair.
 */
export type OmittedIndexSignatureReason = "unrepresentable-key" | "additional-signature";

/**
 * Why a re-export produced no export: its alias chain dead-ends
 * (`missing-target`) or returns to a namespace already being flattened
 * (`cycle`). A third condition, `ambiguous`, is detected above this union by
 * star-export collision analysis and reported with the same code.
 */
export type UnresolvedReExportReason = "missing-target" | "cycle" | "ambiguous";

/**
 * Why an export that looks like a React component was left untransformed.
 * `mixed-component-union` is a capitalized export whose union type holds some
 * arms returning React node types and at least one arm that does not: the
 * component heuristic cannot confirm the export describes one component, so
 * the resolved union kind stands and this warning records the uncertainty
 * instead of silently changing the semantic kind.
 */
export type UncertainComponentRecognitionReason = "mixed-component-union";

/** The extractor substituted `any` for a type shape it cannot model. */
export const UnsupportedTypeFallbackWarningSchema = Schema.Struct({
  ...WarningLocationSchema.fields,
  code: Schema.Literal("unsupported-type-fallback"),
  typeFlags: Schema.Array(Schema.Literals(typeFlagNames)),
  typeText: Schema.String,
  sourceText: Schema.optionalKey(Schema.String),
});
export type UnsupportedTypeFallbackWarning = typeof UnsupportedTypeFallbackWarningSchema.Type;

export const MissingEnumDeclarationWarningSchema = Schema.Struct({
  ...WarningLocationSchema.fields,
  code: Schema.Literal("missing-enum-declaration"),
  enumName: Schema.String,
  memberName: Schema.optionalKey(Schema.String),
});
export type MissingEnumDeclarationWarning = typeof MissingEnumDeclarationWarningSchema.Type;

/**
 * An `export default` expression the checker could not resolve to a symbol,
 * so the export is skipped. Upstream emits the same condition.
 */
export const MissingDefaultExportSymbolWarningSchema = Schema.Struct({
  ...WarningLocationSchema.fields,
  code: Schema.Literal("missing-default-export-symbol"),
  sourceText: Schema.String,
});
export type MissingDefaultExportSymbolWarning = typeof MissingDefaultExportSymbolWarningSchema.Type;

export const OmittedIndexSignatureWarningSchema = Schema.Struct({
  ...WarningLocationSchema.fields,
  code: Schema.Literal("omitted-index-signature"),
  reason: Schema.Literals(["unrepresentable-key", "additional-signature"] as const),
  keyTypes: Schema.Array(Schema.Literals(["string", "number", "symbol", "other"] as const)),
});
export type OmittedIndexSignatureWarning = typeof OmittedIndexSignatureWarningSchema.Type;

/**
 * A construct signature the model cannot carry because its owner is not a
 * class — an interface or object literal type that only declares `new (…)`.
 * Upstream reports such shapes as bare objects; the warning records what was
 * omitted and where in the semantic tree it would have lived.
 */
export const UnrepresentedConstructSignaturesWarningSchema = Schema.Struct({
  ...WarningLocationSchema.fields,
  code: Schema.Literal("unrepresented-construct-signatures"),
  structuralPath: Schema.Array(Schema.String),
  signatureCount: Schema.Natural,
});
export type UnrepresentedConstructSignaturesWarning =
  typeof UnrepresentedConstructSignaturesWarningSchema.Type;

/**
 * Named members a callable shape carries besides its call signatures. A
 * function node has no member list, so an interface that merges call
 * signatures with properties keeps only the callable half; the warning names
 * the members that did not survive.
 */
export const OmittedCallableMembersWarningSchema = Schema.Struct({
  ...WarningLocationSchema.fields,
  code: Schema.Literal("omitted-callable-members"),
  structuralPath: Schema.Array(Schema.String),
  memberNames: Schema.Array(Schema.String),
});
export type OmittedCallableMembersWarning = typeof OmittedCallableMembersWarningSchema.Type;

/**
 * A re-export the module walk could not follow to an original declaration.
 * The export is skipped; the warning names it, says why, and anchors the
 * location at the re-exporting module.
 */
export const UnresolvedReExportWarningSchema = Schema.Struct({
  ...WarningLocationSchema.fields,
  code: Schema.Literal("unresolved-re-export"),
  reason: Schema.Literals(["missing-target", "cycle", "ambiguous"] as const),
  name: Schema.String,
});
export type UnresolvedReExportWarning = typeof UnresolvedReExportWarningSchema.Type;

export const UncertainComponentRecognitionWarningSchema = Schema.Struct({
  ...WarningLocationSchema.fields,
  code: Schema.Literal("uncertain-component-recognition"),
  reason: Schema.Literals(["mixed-component-union"] as const),
  name: Schema.String,
});
export type UncertainComponentRecognitionWarning = typeof UncertainComponentRecognitionWarningSchema.Type;

export const ExtractWarningSchema = Schema.Union([
  UnsupportedTypeFallbackWarningSchema,
  MissingEnumDeclarationWarningSchema,
  MissingDefaultExportSymbolWarningSchema,
  OmittedIndexSignatureWarningSchema,
  UnrepresentedConstructSignaturesWarningSchema,
  OmittedCallableMembersWarningSchema,
  UnresolvedReExportWarningSchema,
  UncertainComponentRecognitionWarningSchema,
]);
export type ExtractWarning = typeof ExtractWarningSchema.Type;
