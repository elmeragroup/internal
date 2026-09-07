import { Schema } from "effect";

export const ComponentSourceRequestSchema = Schema.Struct({
  exportName: Schema.String,
  memberName: Schema.optionalKey(Schema.String),
});
export type ComponentSourceRequest = typeof ComponentSourceRequestSchema.Type;

export const ComponentSourceDefaultSchema = Schema.Struct({
  name: Schema.String,
  initializerText: Schema.String,
});
export type ComponentSourceDefault = typeof ComponentSourceDefaultSchema.Type;

export const ComponentSourceUnresolvedReasonSchema = Schema.Literals([
  "export-not-found",
  "member-not-found",
  "no-implementation",
  "unsupported-wrapper",
  "unsupported-default-expression",
  "unresolved-export",
  "ambiguous-export",
  "cycle",
  "ambiguous-implementation",
] as const);
export type ComponentSourceUnresolvedReason = typeof ComponentSourceUnresolvedReasonSchema.Type;

export const ComponentSourceResolvedSchema = Schema.Struct({
  status: Schema.Literal("resolved"),
  filePath: Schema.String,
  defaults: Schema.Array(ComponentSourceDefaultSchema),
});
export type ComponentSourceResolved = typeof ComponentSourceResolvedSchema.Type;

export const ComponentSourceUnresolvedSchema = Schema.Struct({
  status: Schema.Literal("unresolved"),
  reason: ComponentSourceUnresolvedReasonSchema,
});
export type ComponentSourceUnresolved = typeof ComponentSourceUnresolvedSchema.Type;

export const ComponentSourceResultSchema = Schema.Union([
  ComponentSourceResolvedSchema,
  ComponentSourceUnresolvedSchema,
]);
export type ComponentSourceResult = typeof ComponentSourceResultSchema.Type;

export const ComponentSourceResultsSchema = Schema.Array(ComponentSourceResultSchema);
export type ComponentSourceResults = typeof ComponentSourceResultsSchema.Type;
