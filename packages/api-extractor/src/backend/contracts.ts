import type { IntrinsicName } from "../model.ts";
import type { ExtractWarning, TypeFlagName } from "../warnings.ts";

declare const backendHandleBrand: unique symbol;

/**
 * Compiler entities never cross the backend boundary as compiler objects.
 * Handles are created and dereferenced by one extraction session only.
 */
export type BackendHandle<Tag extends string> = {
  readonly [backendHandleBrand]: Tag;
  readonly kind: Tag;
  readonly id: number;
  readonly session: symbol;
};

export type BackendSymbolHandle = BackendHandle<"symbol">;
export type BackendTypeHandle = BackendHandle<"type">;
export type BackendNodeHandle = BackendHandle<"node">;
export type BackendTypeNodeHandle = BackendHandle<"type-node">;
export type BackendSignatureHandle = BackendHandle<"signature">;
export type BackendNodeReference = BackendNodeHandle | BackendTypeNodeHandle;

type BackendSymbolFlag = "alias" | "class" | "typeParameter" | "optional";

/** Stable checker identity for a symbol, with aliases resolved by the backend. */
export type BackendSymbolIdentity = {
  readonly name: string;
  readonly namespaces: readonly string[];
};

/**
 * The normalized module that introduced a symbol through an import or
 * re-export.  `moduleSpecifier` is authored module identity, not a source
 * path; `external` is compiler ownership of the resolved module declaration.
 * Keeping the two facts separate lets parser policy distinguish a public
 * package from a project-local path-mapped module without inspecting paths.
 */
export type BackendModuleOrigin = {
  readonly moduleSpecifier: string;
  readonly packageName?: string;
  readonly external: boolean;
};

/** One parser-facing identity/origin observation for an invoked symbol. */
type BackendCalleeFacts = {
  readonly symbol: BackendSymbolHandle;
  readonly identity?: BackendSymbolIdentity;
  readonly moduleOrigin?: BackendModuleOrigin;
};

/** A normalized compiler observation. It has no semantic model values. */
export type BackendTypeFacts = {
  readonly flags: readonly TypeFlagName[];
  readonly intrinsic?: BackendIntrinsicName;
  readonly literal?: string | number | boolean;
  readonly isError?: boolean;
  readonly isTypeParameter?: boolean;
  readonly isUnion?: boolean;
  readonly isIntersection?: boolean;
  readonly isTuple?: boolean;
  readonly isObject?: boolean;
  readonly isEnum?: boolean;
  readonly symbol?: BackendSymbolHandle;
  readonly aliasSymbol?: BackendSymbolHandle;
  readonly unionOrIntersectionTypes?: readonly BackendTypeHandle[];
  /** The operand of an index (`keyof`) type; present exactly when the type is one. */
  readonly indexTarget?: BackendTypeHandle;
  /**
   * The three operand types of a deferred conditional (`T extends U ? X : Y`).
   * The check type drives upstream's built-in-`Extract` gate; the resolved
   * branch types drive its conditional branch recovery. Absent for every
   * other type.
   */
  readonly conditionalCheckType?: BackendTypeHandle;
  readonly conditionalTrueType?: BackendTypeHandle;
  readonly conditionalFalseType?: BackendTypeHandle;
  /**
   * A checker-internal substitution's base and constraint. Substitutions have
   * no model form of their own; the resolver probes these the way upstream's
   * `resolveSubstitutionFallback` does.
   */
  readonly substitutionBaseType?: BackendTypeHandle;
  readonly substitutionConstraint?: BackendTypeHandle;
  /** The uninstantiated generic a type reference instantiates; present exactly when the type is one. */
  readonly referenceTarget?: BackendTypeHandle;
  readonly typeArguments?: readonly BackendTypeHandle[];
  readonly aliasTypeArguments?: readonly BackendTypeHandle[];
};

export type BackendEnumMemberFacts = {
  readonly name: string;
  readonly value: string | number;
  readonly symbol: BackendSymbolHandle;
  readonly declaration?: BackendNodeHandle;
  readonly documentation?: BackendDocumentation;
};

export type BackendEnumFacts = {
  readonly name: string;
  readonly namespaces: readonly string[];
  readonly members: readonly BackendEnumMemberFacts[];
  readonly documentation?: BackendDocumentation;
  /** Recoverable enum members/declarations that could not be normalized. */
  readonly warnings?: readonly BackendWarningFact[];
};

export type BackendSymbolFacts = {
  readonly name: string;
  readonly flags: readonly BackendSymbolFlag[];
  readonly declarationPaths: readonly string[];
  /** Repository-relative declaration paths for durable provenance output. */
  readonly repositoryRelativeDeclarationPaths?: readonly string[];
  readonly declarations: readonly BackendNodeHandle[];
  readonly valueDeclaration?: BackendNodeHandle;
};

/**
 * Alias-resolved identity and authored import origin. Separate from
 * `symbolFacts` so ordinary member loops do not pay `getAliasedSymbol` or
 * origin resolution.
 */
export type BackendSymbolOrigin = {
  readonly identity: BackendSymbolIdentity;
  readonly moduleOrigin?: BackendModuleOrigin;
};

/**
 * Neutral ownership of one declaration's source file.
 *
 * The discriminator is intentional: a replacement backend must choose an
 * owner instead of silently omitting one of several correlated booleans. A
 * dependency carries only its normalized package identity; an external file
 * whose package owner cannot be established has its own conservative variant.
 * TypeScript's compiler-owned files distinguish the strict default library
 * from another toolchain declaration because the two gates have different
 * semantics.
 */
export type BackendDeclarationOwnership =
  | { readonly kind: "project" }
  | { readonly kind: "dependency"; readonly packageName: string }
  | { readonly kind: "external" }
  | { readonly kind: "typescript"; readonly library: "standard-library" | "toolchain" };

/** Dependency, unowned external and TypeScript declarations are all outside the project. */
export function isExternalOwnership(ownership: BackendDeclarationOwnership): boolean {
  return ownership.kind !== "project";
}

/**
 * Which declarations outside the project one extraction may expand: none,
 * every dependency, or an exact set of package names. The parser derives it
 * from `includeExternalTypes`; the backend applies the same policy to the
 * source files it materializes on the parser's behalf.
 */
export type BackendExternalTypeSelection =
  | { readonly kind: "none" }
  | { readonly kind: "all" }
  | { readonly kind: "packages"; readonly packageNames: ReadonlySet<string> };

/** Whether one normalized declaration owner is eligible under a selection. */
export function externalTypeSelectionAllowsOwnership(
  ownership: BackendDeclarationOwnership,
  selection: BackendExternalTypeSelection
): boolean {
  if (ownership.kind === "project" || selection.kind === "all") return true;
  return (
    selection.kind === "packages" &&
    ownership.kind === "dependency" &&
    selection.packageNames.has(ownership.packageName)
  );
}

export type BackendTypeNameFacts = {
  readonly name: string;
  readonly namespaces: readonly string[];
  readonly authoredArguments?: readonly BackendTypeNodeHandle[];
  readonly authoredSymbol?: BackendSymbolHandle;
  /**
   * Which of TypeScript's own array interfaces an authored reference names, or
   * absent when it names anything else. The name text alone cannot answer this:
   * a project may declare its own `Array`, and any other generic's first type
   * argument is not its element type. The backend answers it from the checker —
   * the referenced symbol resolved through aliases, carrying the interface flag,
   * and declared in a TypeScript library file — so a consumer can recover array
   * element syntax without trusting the spelling.
   */
  readonly builtInArray?: "Array" | "ReadonlyArray";
};

export type BackendNodeFacts = {
  readonly kind:
    | "unknown"
    | "type"
    | "typeAlias"
    | "interface"
    | "class"
    | "classExpression"
    | "enum"
    | "enumMember"
    | "function"
    | "parameter"
    | "property"
    | "method"
    | "methodSignature"
    | "getAccessor"
    | "setAccessor"
    | "variable"
    | "callExpression"
    | "exportSpecifier"
    | "exportDeclaration"
    | "typeReference"
    | "typeQuery"
    | "union"
    | "intersection"
    | "typeOperator"
    | "mapped"
    | "parenthesized"
    | "typeParameter"
    | "functionLike"
    | "indexSignature"
    | "array"
    | "tuple";
  readonly text: string;
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  /** A declaration's authored type node, if it has one. This is deliberately not a generic node handle. */
  readonly type?: BackendTypeNodeHandle;
  readonly children?: readonly BackendNodeReference[];
  /**
   * Which authored tuple positions are rest elements, parallel to `children`.
   * A rest position expands into a different number of semantic elements than
   * the single node it was written as, so the resolver needs to know which
   * positions those are before it can align authored syntax with the checker's
   * element list.
   */
  readonly restElements?: readonly boolean[];
  readonly typeName?: BackendTypeNameFacts;
  readonly operator?: "keyof" | "readonly";
  readonly optional?: boolean;
  readonly name?: string;
  /**
   * The authored expression of a `typeof` type query — the value name, or the
   * `import(…)` expression for `typeof import(…)`. The model stores it verbatim
   * (`TypeQueryNode.expressionName`).
   */
  readonly expressionName?: string;
  readonly initializerText?: string;
  readonly initializer?: BackendNodeHandle;
  readonly arguments?: readonly BackendNodeHandle[];
  /** The invoked expression and its checker symbol, when one is available. */
  readonly callee?: BackendNodeHandle;
  /** One coherent identity/origin result for the invoked symbol. */
  readonly calleeFacts?: BackendCalleeFacts;
  readonly constraint?: BackendTypeNodeHandle;
  readonly defaultType?: BackendTypeNodeHandle;
  readonly typeParameters?: readonly BackendNodeHandle[];
  readonly parameters?: readonly BackendNodeHandle[];
  readonly returnType?: BackendTypeNodeHandle;
  readonly valueType?: BackendTypeNodeHandle;
  readonly keyName?: string;
  readonly keyType?: "string" | "number";
  readonly mappedOptional?: boolean;
  readonly mappedValueType?: BackendTypeNodeHandle;
  /** A mapped type's `as` clause, which renames keys away from the constraint. */
  readonly mappedNameType?: BackendTypeNodeHandle;
  readonly heritageTypes?: readonly BackendNodeReference[];
  readonly declarationFlags?: readonly ("readonly" | "private" | "protected" | "static")[];
  /** Defaults authored on object-binding elements, normalized at the backend seam. */
  readonly bindingDefaults?: readonly BackendBindingDefaultFact[];
  /**
   * Source-inspection defaults for a parameter. Unlike `bindingDefaults`, a
   * nested binding pattern still reports its outer property name.
   */
  readonly sourceBindingDefaults?: readonly BackendBindingDefaultFact[];
  /**
   * The value symbol an identifier or shorthand assignment refers to, with
   * aliases resolved. Distinct from the expression's type symbol.
   */
  readonly referencedValueSymbol?: BackendSymbolHandle;
  /** Inner expression of parentheses, assertions, non-null, and satisfies. */
  readonly innerExpression?: BackendNodeHandle;
  /** Whether a function-like declaration has an implementation body. */
  readonly hasImplementationBody?: boolean;
  /**
   * Who owns the node's source file. Read for source inspection only, where the
   * walk must tell a forwarded dependency declaration from a project `.d.ts`.
   */
  readonly ownership?: BackendDeclarationOwnership;
};

type BackendBindingDefaultFact = {
  readonly name: string;
  readonly initializerText: string;
};

export type BackendSignatureFacts = {
  readonly parameters: readonly BackendSymbolHandle[];
  readonly returnType?: BackendTypeHandle;
  readonly typeParameters: readonly BackendTypeHandle[];
  readonly declaration?: BackendNodeHandle;
};

export type BackendIndexSignatureFacts = {
  readonly keyName?: string;
  /**
   * The index key domain. `symbol` and `other` (a template-literal or pattern
   * key) exist so the resolver can report a signature the semantic model cannot
   * represent instead of dropping it silently.
   */
  readonly keyType: "string" | "number" | "symbol" | "other";
  readonly valueType: BackendTypeHandle;
  readonly isReadonly?: boolean;
  readonly declaration?: BackendNodeHandle;
};

export type BackendExportDraft = {
  readonly name: string;
  readonly symbol: BackendSymbolHandle;
  readonly symbolStack?: readonly string[];
  readonly documentation?: BackendDocumentation;
  readonly declarationSourcePath?: string;
  readonly pureType?: boolean;
  readonly explicitValueReExport?: boolean;
  /** The original authored name of a renamed module re-export (`export { A as B }`). */
  readonly reexportedFrom?: string;
  /**
   * Repository-relative files of each intermediate re-export declaration on
   * the way to the original declaration site, outermost first. The origin is
   * carried by the symbol facts' declaration paths, not repeated here.
   */
  readonly reexportChain?: readonly string[];
  /**
   * Compiler file path of the innermost re-export declaration on that chain,
   * the authored module whose statement forwards the original declaration.
   * Present exactly when `reexportChain` is.
   */
  readonly forwardingFilePath?: string;
  readonly extendsTypes?: readonly { readonly name: string; readonly resolvedName?: string }[];
};

/** Operations expressed solely in package-owned handles and primitive facts. */
export type BackendCompilerOperations = {
  /** Updates breadcrumbs included in backend failures for this extraction. */
  readonly setErrorContext: (symbolStack: readonly string[]) => void;
  readonly typeOfSymbol: (symbol: BackendSymbolHandle, declared: boolean) => BackendTypeHandle | undefined;
  readonly typeAtNode: (node: BackendNodeReference) => BackendTypeHandle | undefined;
  readonly typeFacts: (type: BackendTypeHandle) => BackendTypeFacts;
  readonly symbolFacts: (symbol: BackendSymbolHandle) => BackendSymbolFacts;
  /**
   * Alias-resolved identity and authored import origin. Ordinary `symbolFacts`
   * reads must not pay `getAliasedSymbol` or origin resolution for this.
   */
  readonly symbolOrigin: (symbol: BackendSymbolHandle) => BackendSymbolOrigin;
  /**
   * Cheap parent-flags bit for object visibility. Not a `symbolFacts` field:
   * ordinary symbol reads must not pay `getParent()` for this gate, and the
   * record does not advertise the bit independently of identity or origin.
   */
  readonly declaringParentIsClass: (symbol: BackendSymbolHandle) => boolean;
  readonly documentationOfSymbol: (symbol: BackendSymbolHandle) => BackendDocumentation | undefined;
  readonly enumFacts: (type: BackendTypeHandle) => BackendEnumFacts | undefined;
  readonly nodeFacts: (node: BackendNodeReference) => BackendNodeFacts;
  /**
   * Declaration or type-node kind, always equal to `nodeFacts(node).kind`.
   * Answered from the handle's compiler kind without resolving the AST, except
   * for import-type handles, whose `typeof` form needs the resolved node.
   */
  readonly nodeKind: (node: BackendNodeReference) => BackendNodeFacts["kind"];
  readonly typeNameFacts: (
    type: BackendTypeHandle,
    sourceNode: BackendNodeReference | undefined
  ) => BackendTypeNameFacts | undefined;
  readonly signaturesOfType: (type: BackendTypeHandle) => readonly BackendSignatureHandle[];
  /** Construct (`new`) signatures of a type; a graph without classes answers with an empty list. */
  readonly constructSignaturesOfType: (type: BackendTypeHandle) => readonly BackendSignatureHandle[];
  readonly signatureFacts: (signature: BackendSignatureHandle) => BackendSignatureFacts;
  /**
   * Documentation authored directly on a declaration node, which is where
   * TypeScript keeps constructor JSDoc — no checker symbol carries it.
   */
  readonly documentationOfNode: (node: BackendNodeReference) => BackendDocumentation | undefined;
  /**
   * Documentation authored for one signature parameter, read from the owning
   * declaration's own `@param` entry so overloaded owners cannot leak another
   * overload's summary into this one. Falls back to nothing rather than to an
   * aggregate; callers may layer their own fallback.
   */
  readonly documentationOfParameter: (
    parameter: BackendSymbolHandle,
    ownerDeclaration?: BackendNodeHandle
  ) => BackendDocumentation | undefined;
  /** Normalized source-file ownership of one declaration. */
  readonly declarationOwnership: (node: BackendNodeReference) => BackendDeclarationOwnership;
  readonly propertiesOfType: (type: BackendTypeHandle) => readonly BackendSymbolHandle[];
  readonly propertyType: (property: BackendSymbolHandle) => BackendTypeHandle | undefined;
  readonly indexSignaturesOfType: (type: BackendTypeHandle) => readonly BackendIndexSignatureFacts[];
  readonly baseConstraintOfType: (type: BackendTypeHandle) => BackendTypeHandle | undefined;
  readonly isArrayType: (type: BackendTypeHandle) => boolean;
  readonly isReadonlyType: (type: BackendTypeHandle) => boolean;
  readonly typeToString: (type: BackendTypeHandle) => string;
};

/**
 * A warning as the backend and resolver record it: every structured field of
 * the public `ExtractWarning`, minus the rendered `message`, which
 * `parse/fallback.ts` adds once at the package boundary.
 */
export type BackendWarningFact = ExtractWarning extends infer Warning
  ? Warning extends { readonly code: string }
    ? Omit<Warning, "message">
    : never
  : never;

/** The backend reports the same intrinsic vocabulary the model publishes. */
export type BackendIntrinsicName = IntrinsicName;

/**
 * Whether a name is one of TypeScript's internal `__`-prefixed symbol names,
 * which never describe a public API name.
 *
 * The one prefix rule for both the compiler-free resolver modules and the
 * backend module walk. Deliberately NOT the backend fact reader's closed
 * allowlist (`internalSymbolNames` in `ts7/facts.ts`, which also admits
 * "VoidOrUndefinedOnly" — no `__` prefix): unifying either direction would
 * change which names are refused, so the two policies stay apart on purpose.
 */
export function isInternalSymbolName(name: string): boolean {
  return name.startsWith("__");
}

export type BackendDocumentation = {
  readonly description?: string;
  readonly defaultValue?: string;
  readonly visibility?: "public" | "private" | "internal";
  readonly tags: readonly { readonly name: string; readonly value?: string }[];
};

export type BackendModuleDraft = {
  readonly name: string;
  readonly exports: readonly BackendExportDraft[];
  readonly imports?: readonly string[];
  readonly typeOnlyStarExports?: readonly string[];
  /** Structured module-walk warnings (re-export resolution failures). */
  readonly warnings?: readonly BackendWarningFact[];
};

export type BackendExtractionSession = {
  /** Validates project membership and module-ness before returning normalized facts. */
  readonly readModule: (filePath: string) => BackendModuleDraft;
  readonly compiler: BackendCompilerOperations;
  /** Uses the TS7 project's configured module-resolution rules. */
  readonly resolveModule: (
    moduleSpecifier: string,
    containingFile: string
  ) => BackendResolvedModule | undefined;
  readonly close: () => void;
};

/** Per-extraction policy the parser settled before the session opened. */
export type BackendExtractionOptions = {
  readonly externalTypes?: BackendExternalTypeSelection;
  /** Read implementation bodies for source inspection, without expanding semantic extraction work. */
  readonly componentSources?: boolean;
};

export type BackendProject = {
  readonly openExtraction: (options?: BackendExtractionOptions) => BackendExtractionSession;
  readonly getTimingInfo?: () => BackendTiming;
  readonly close: () => void;
};

export type BackendResolvedModule = { readonly filePath: string };

type BackendTimingRequest = {
  readonly method: string;
  readonly roundTripMs: number;
  readonly bytesSent: number;
  readonly bytesReceived: number;
  readonly serverTimeMs?: number;
  readonly transportOverheadMs?: number;
};

export type BackendTiming = {
  readonly enabled: boolean;
  readonly totals: {
    readonly requestCount: number;
    readonly roundTripMs: number;
    readonly bytesSent: number;
    readonly bytesReceived: number;
    readonly serverTimeMs: number;
    readonly transportOverheadMs: number;
    readonly nodesMaterialized: number;
    readonly sourceFilesFetched: number;
    readonly nodesFetched: number;
  };
  readonly recentRequests: readonly BackendTimingRequest[];
};

/** The timing a backend reports when it collected none. */
export function disabledTiming(): BackendTiming {
  return {
    enabled: false,
    totals: {
      requestCount: 0,
      roundTripMs: 0,
      bytesSent: 0,
      bytesReceived: 0,
      serverTimeMs: 0,
      transportOverheadMs: 0,
      nodesMaterialized: 0,
      sourceFilesFetched: 0,
      nodesFetched: 0,
    },
    recentRequests: [],
  };
}
