import { Schema } from "effect";

import { ProvenanceEntrySchema } from "./provenance.ts";
import { ExtractWarningSchema } from "./warnings.ts";

/** Every intrinsic the model can name; the type, the schema, and the backend contract derive from it. */
export const intrinsicNames = [
  "any",
  "bigint",
  "boolean",
  "never",
  "null",
  "number",
  "string",
  "symbol",
  "undefined",
  "unknown",
  "void",
] as const;

export type IntrinsicName = (typeof intrinsicNames)[number];

export type TypeName = typeof TypeNameSchema.Type;

export type TypeArgument = {
  readonly type: SemanticType;
  readonly equalToDefault: boolean;
};

const DocumentationTagSchema = Schema.Struct({
  name: Schema.String,
  value: Schema.optionalKey(Schema.String),
});
export type DocumentationTag = typeof DocumentationTagSchema.Type;

const DocumentationSchema = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  defaultValue: Schema.optionalKey(Schema.String),
  visibility: Schema.optionalKey(Schema.Literals(["public", "private", "internal"] as const)),
  tags: Schema.Array(DocumentationTagSchema),
});
export type Documentation = typeof DocumentationSchema.Type;

export type IntrinsicNode = {
  readonly kind: "intrinsic";
  readonly typeName?: TypeName;
  readonly intrinsic: IntrinsicName;
};

export type ParameterNode = {
  readonly type: SemanticType;
  readonly name: string;
  readonly documentation?: Documentation;
  readonly optional: boolean;
  readonly defaultValue?: string;
};

export type TypeParameterNode = {
  readonly name: string;
  readonly constraint?: SemanticType;
  readonly defaultValue?: SemanticType;
  readonly kind: "typeParameter";
};

export type CallSignatureNode = {
  readonly parameters: readonly ParameterNode[];
  readonly returnValueType: SemanticType;
  readonly typeParameters?: readonly TypeParameterNode[];
};

export type FunctionNode = {
  readonly kind: "function";
  readonly typeName?: TypeName;
  readonly callSignatures: readonly CallSignatureNode[];
};

export type PropertyNode = {
  readonly name: string;
  readonly type: SemanticType;
  readonly documentation?: Documentation;
  readonly optional: boolean;
};

export type IndexSignatureNode = {
  readonly keyName?: string;
  readonly keyType: "string" | "number";
  readonly valueType: SemanticType;
};

export type ObjectNode = {
  readonly kind: "object";
  readonly typeName?: TypeName;
  readonly properties: readonly PropertyNode[];
  readonly documentation?: Documentation;
  readonly indexSignature?: IndexSignatureNode;
};

export type ComponentNode = {
  readonly kind: "component";
  readonly typeName?: TypeName;
  readonly props: readonly PropertyNode[];
};

export type ExternalTypeNode = {
  readonly kind: "external";
  readonly typeName: TypeName;
};

export type UnionNode = {
  readonly kind: "union";
  readonly typeName?: TypeName;
  readonly types: readonly SemanticType[];
};

export type IntersectionNode = {
  readonly kind: "intersection";
  readonly typeName?: TypeName;
  readonly types: readonly SemanticType[];
  readonly properties: readonly PropertyNode[];
};

export type TypeOperatorResolutionKind = "exact" | "baseConstraint" | "fallback";

export type TypeOperatorNode = {
  readonly kind: "typeOperator";
  readonly typeName?: TypeName;
  readonly operator: "keyof";
  readonly type: SemanticType;
  /** The checker's key set for the operand; `type` keeps the authored expression. */
  readonly resolvedType: SemanticType;
  readonly resolutionKind: TypeOperatorResolutionKind;
};

export type LiteralNode = {
  readonly kind: "literal";
  readonly typeName?: TypeName;
  readonly value: string | number | boolean;
  readonly documentation?: Documentation;
};

export type EnumMember = {
  readonly name: string;
  readonly value: string | number;
  readonly documentation?: Documentation;
};

export type EnumNode = {
  readonly kind: "enum";
  readonly typeName: TypeName;
  readonly members: readonly EnumMember[];
  readonly documentation?: Documentation;
};

export type ArrayNode = {
  readonly kind: "array";
  readonly typeName?: TypeName;
  readonly elementType: SemanticType;
  readonly isReadonly?: true;
};

export type TupleNode = {
  readonly kind: "tuple";
  readonly typeName?: TypeName;
  readonly types: readonly SemanticType[];
  readonly isReadonly?: true;
};

export type TypeQueryNode = {
  readonly kind: "typeQuery";
  readonly expressionName: string;
};

export type ClassProperty = PropertyNode & {
  readonly readonly: boolean;
  readonly isStatic?: boolean;
};

export type ConstructSignatureNode = {
  readonly parameters: readonly ParameterNode[];
  readonly documentation?: Documentation;
};

export type ClassMethod = {
  readonly name: string;
  readonly documentation?: Documentation;
  readonly isStatic?: boolean;
  readonly callSignatures: readonly CallSignatureNode[];
};

export type ClassNode = {
  readonly kind: "class";
  readonly typeName?: TypeName;
  readonly constructSignatures: readonly ConstructSignatureNode[];
  readonly properties: readonly ClassProperty[];
  readonly methods: readonly ClassMethod[];
  readonly typeParameters?: readonly TypeName[];
};

export type SemanticType =
  | ArrayNode
  | ClassNode
  | ComponentNode
  | EnumNode
  | ExternalTypeNode
  | FunctionNode
  | IntersectionNode
  | IntrinsicNode
  | LiteralNode
  | ObjectNode
  | TupleNode
  | TypeOperatorNode
  | TypeParameterNode
  | TypeQueryNode
  | UnionNode;

const TypeNameSchema = Schema.Struct({
  name: Schema.String,
  namespaces: Schema.optionalKey(Schema.Array(Schema.String)),
  typeArguments: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        type: Schema.suspend((): Schema.Codec<SemanticType> => SemanticTypeSchema),
        equalToDefault: Schema.Boolean,
      })
    )
  ),
});

const IntrinsicNodeSchema: Schema.Codec<IntrinsicNode> = Schema.Struct({
  kind: Schema.Literal("intrinsic"),
  typeName: Schema.optionalKey(TypeNameSchema),
  intrinsic: Schema.Literals(intrinsicNames),
});

const PropertyNodeSchema: Schema.Codec<PropertyNode> = Schema.Struct({
  name: Schema.String,
  type: Schema.suspend((): Schema.Codec<SemanticType> => SemanticTypeSchema),
  documentation: Schema.optionalKey(DocumentationSchema),
  optional: Schema.Boolean,
});

const IndexSignatureNodeSchema: Schema.Codec<IndexSignatureNode> = Schema.Struct({
  keyName: Schema.optionalKey(Schema.String),
  keyType: Schema.Literals(["string", "number"] as const),
  valueType: Schema.suspend((): Schema.Codec<SemanticType> => SemanticTypeSchema),
});

const ParameterNodeSchema: Schema.Codec<ParameterNode> = Schema.Struct({
  type: Schema.suspend((): Schema.Codec<SemanticType> => SemanticTypeSchema),
  name: Schema.String,
  documentation: Schema.optionalKey(DocumentationSchema),
  optional: Schema.Boolean,
  defaultValue: Schema.optionalKey(Schema.String),
});

const TypeParameterNodeSchema: Schema.Codec<TypeParameterNode> = Schema.Struct({
  name: Schema.String,
  constraint: Schema.optionalKey(Schema.suspend((): Schema.Codec<SemanticType> => SemanticTypeSchema)),
  defaultValue: Schema.optionalKey(Schema.suspend((): Schema.Codec<SemanticType> => SemanticTypeSchema)),
  kind: Schema.Literal("typeParameter"),
});

const CallSignatureNodeSchema: Schema.Codec<CallSignatureNode> = Schema.Struct({
  parameters: Schema.Array(ParameterNodeSchema),
  returnValueType: Schema.suspend((): Schema.Codec<SemanticType> => SemanticTypeSchema),
  typeParameters: Schema.optionalKey(Schema.Array(TypeParameterNodeSchema)),
});

const FunctionNodeSchema: Schema.Codec<FunctionNode> = Schema.Struct({
  kind: Schema.Literal("function"),
  typeName: Schema.optionalKey(TypeNameSchema),
  callSignatures: Schema.Array(CallSignatureNodeSchema),
});

const ObjectNodeSchema: Schema.Codec<ObjectNode> = Schema.Struct({
  kind: Schema.Literal("object"),
  typeName: Schema.optionalKey(TypeNameSchema),
  properties: Schema.Array(PropertyNodeSchema),
  documentation: Schema.optionalKey(DocumentationSchema),
  indexSignature: Schema.optionalKey(IndexSignatureNodeSchema),
});

const ComponentNodeSchema: Schema.Codec<ComponentNode> = Schema.Struct({
  kind: Schema.Literal("component"),
  typeName: Schema.optionalKey(TypeNameSchema),
  props: Schema.Array(PropertyNodeSchema),
});

const ExternalTypeNodeSchema: Schema.Codec<ExternalTypeNode> = Schema.Struct({
  kind: Schema.Literal("external"),
  typeName: TypeNameSchema,
});

const UnionNodeSchema: Schema.Codec<UnionNode> = Schema.Struct({
  kind: Schema.Literal("union"),
  typeName: Schema.optionalKey(TypeNameSchema),
  types: Schema.Array(Schema.suspend((): Schema.Codec<SemanticType> => SemanticTypeSchema)),
});

const IntersectionNodeSchema: Schema.Codec<IntersectionNode> = Schema.Struct({
  kind: Schema.Literal("intersection"),
  typeName: Schema.optionalKey(TypeNameSchema),
  types: Schema.Array(Schema.suspend((): Schema.Codec<SemanticType> => SemanticTypeSchema)),
  properties: Schema.Array(PropertyNodeSchema),
});

const TypeOperatorNodeSchema: Schema.Codec<TypeOperatorNode> = Schema.Struct({
  kind: Schema.Literal("typeOperator"),
  typeName: Schema.optionalKey(TypeNameSchema),
  operator: Schema.Literal("keyof"),
  type: Schema.suspend((): Schema.Codec<SemanticType> => SemanticTypeSchema),
  resolvedType: Schema.suspend((): Schema.Codec<SemanticType> => SemanticTypeSchema),
  resolutionKind: Schema.Literals(["exact", "baseConstraint", "fallback"] as const),
});

const LiteralNodeSchema: Schema.Codec<LiteralNode> = Schema.Struct({
  kind: Schema.Literal("literal"),
  typeName: Schema.optionalKey(TypeNameSchema),
  value: Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
  documentation: Schema.optionalKey(DocumentationSchema),
});

const EnumMemberSchema: Schema.Codec<EnumMember> = Schema.Struct({
  name: Schema.String,
  value: Schema.Union([Schema.String, Schema.Number]),
  documentation: Schema.optionalKey(DocumentationSchema),
});

const EnumNodeSchema: Schema.Codec<EnumNode> = Schema.Struct({
  kind: Schema.Literal("enum"),
  typeName: TypeNameSchema,
  members: Schema.Array(EnumMemberSchema),
  documentation: Schema.optionalKey(DocumentationSchema),
});

const ArrayNodeSchema: Schema.Codec<ArrayNode> = Schema.Struct({
  kind: Schema.Literal("array"),
  typeName: Schema.optionalKey(TypeNameSchema),
  elementType: Schema.suspend((): Schema.Codec<SemanticType> => SemanticTypeSchema),
  isReadonly: Schema.optionalKey(Schema.Literal(true)),
});

const TupleNodeSchema: Schema.Codec<TupleNode> = Schema.Struct({
  kind: Schema.Literal("tuple"),
  typeName: Schema.optionalKey(TypeNameSchema),
  types: Schema.Array(Schema.suspend((): Schema.Codec<SemanticType> => SemanticTypeSchema)),
  isReadonly: Schema.optionalKey(Schema.Literal(true)),
});

const TypeQueryNodeSchema: Schema.Codec<TypeQueryNode> = Schema.Struct({
  kind: Schema.Literal("typeQuery"),
  expressionName: Schema.String,
});

const ClassPropertySchema: Schema.Codec<ClassProperty> = Schema.Struct({
  name: Schema.String,
  type: Schema.suspend((): Schema.Codec<SemanticType> => SemanticTypeSchema),
  documentation: Schema.optionalKey(DocumentationSchema),
  optional: Schema.Boolean,
  readonly: Schema.Boolean,
  isStatic: Schema.optionalKey(Schema.Boolean),
});

const ConstructSignatureNodeSchema: Schema.Codec<ConstructSignatureNode> = Schema.Struct({
  parameters: Schema.Array(ParameterNodeSchema),
  documentation: Schema.optionalKey(DocumentationSchema),
});

const ClassMethodSchema: Schema.Codec<ClassMethod> = Schema.Struct({
  name: Schema.String,
  documentation: Schema.optionalKey(DocumentationSchema),
  isStatic: Schema.optionalKey(Schema.Boolean),
  callSignatures: Schema.Array(CallSignatureNodeSchema),
});

const ClassNodeSchema: Schema.Codec<ClassNode> = Schema.Struct({
  kind: Schema.Literal("class"),
  typeName: Schema.optionalKey(TypeNameSchema),
  constructSignatures: Schema.Array(ConstructSignatureNodeSchema),
  properties: Schema.Array(ClassPropertySchema),
  methods: Schema.Array(ClassMethodSchema),
  typeParameters: Schema.optionalKey(Schema.Array(TypeNameSchema)),
});

export const SemanticTypeSchema: Schema.Codec<SemanticType> = Schema.Union([
  ArrayNodeSchema,
  ClassNodeSchema,
  ComponentNodeSchema,
  EnumNodeSchema,
  ExternalTypeNodeSchema,
  FunctionNodeSchema,
  IntersectionNodeSchema,
  IntrinsicNodeSchema,
  LiteralNodeSchema,
  ObjectNodeSchema,
  TupleNodeSchema,
  TypeOperatorNodeSchema,
  TypeParameterNodeSchema,
  TypeQueryNodeSchema,
  UnionNodeSchema,
]);

const ExportNodeSchema = Schema.Struct({
  name: Schema.String,
  type: SemanticTypeSchema,
  documentation: Schema.optionalKey(DocumentationSchema),
  reexportedFrom: Schema.optionalKey(Schema.String),
  extendsTypes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        resolvedName: Schema.optionalKey(Schema.String),
      })
    )
  ),
});

export type ExportNode = typeof ExportNodeSchema.Type;

export const ModuleNodeSchema = Schema.Struct({
  name: Schema.String,
  exports: Schema.Array(ExportNodeSchema),
  imports: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type ModuleNode = typeof ModuleNodeSchema.Type;

export const ExtractionResultSchema = Schema.Struct({
  module: ModuleNodeSchema,
  warnings: Schema.Array(ExtractWarningSchema),
  provenance: Schema.Array(ProvenanceEntrySchema),
});
