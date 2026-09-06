/**
 * The fixture tables each behaviour suite owns.
 *
 * Grouping and order are a property of the suite that asserts them, not of
 * the fixture tree, so they live beside the tests instead of in the derived
 * catalog. Each row names the fixture directory, its input file, whether its
 * oracle is the immutable upstream one or a reviewed TypeScript 7
 * divergence, and the family the suite groups it under.
 */

export type SuiteFixture = {
  readonly fixture: string;
  readonly file: string;
  readonly oracle: "immutable-upstream" | "reviewed-ts7";
  readonly family?: string;
};

/** Object and enum API surfaces. */
export const objectApiFixtures: readonly SuiteFixture[] = [
  { fixture: "type-object-shape-resolution", file: "input.ts", oracle: "immutable-upstream" },
  { fixture: "enum-members-values-and-docs", file: "input.ts", oracle: "immutable-upstream" },
  { fixture: "jsdoc-extra-tags-preservation", file: "input.ts", oracle: "immutable-upstream" },
  { fixture: "object-property-count-limit-scope", file: "input.tsx", oracle: "immutable-upstream" },
  { fixture: "function-parameters-optional-and-defaults", file: "input.ts", oracle: "immutable-upstream" },
];

/** Unions, intersections and canonical ordering. */
export const canonicalizationFixtures: readonly SuiteFixture[] = [
  {
    fixture: "distributive-conditional-intersection-expansion",
    file: "input.ts",
    oracle: "immutable-upstream",
  },
  { fixture: "intersection-order-deduplication", file: "input.ts", oracle: "immutable-upstream" },
  { fixture: "large-nested-union-any-order", file: "input.ts", oracle: "immutable-upstream" },
  { fixture: "nested-function-union-any-deduplication", file: "input.ts", oracle: "immutable-upstream" },
  { fixture: "type-alias-union-member-resolution", file: "input.ts", oracle: "immutable-upstream" },
  { fixture: "type-indexed-access-union-resolution", file: "input.ts", oracle: "immutable-upstream" },
  { fixture: "type-intersection-resolution", file: "input.ts", oracle: "immutable-upstream" },
  { fixture: "type-never-resolution", file: "input.ts", oracle: "immutable-upstream" },
  { fixture: "type-union-object-props-resolution", file: "input.tsx", oracle: "immutable-upstream" },
  { fixture: "union-any-wildcard-order", file: "input.ts", oracle: "immutable-upstream" },
  { fixture: "union-never-reduction", file: "input.ts", oracle: "immutable-upstream" },
  { fixture: "mapped-type-prettify-intersection-resolution", file: "input.ts", oracle: "reviewed-ts7" },
];

/** Containers: arrays, tuples and records. */
export const containerFixtures: readonly SuiteFixture[] = [
  {
    fixture: "type-array-syntax-resolution",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "array",
  },
  { fixture: "type-tuple-resolution", file: "input.ts", oracle: "immutable-upstream", family: "tuple" },
  {
    fixture: "mapped-tuple-rest-synthetic-key",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "tuple",
  },
  { fixture: "type-record-resolution", file: "input.ts", oracle: "immutable-upstream", family: "record" },
  {
    fixture: "type-utility-types-resolution",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "record",
  },
  {
    fixture: "type-index-signature-resolution",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "indexSignature",
  },
  {
    fixture: "generic-callback-index-signature-deduplication",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "indexSignature",
  },
  { fixture: "mapped-alias-finite-key", file: "input.ts", oracle: "immutable-upstream", family: "mappedKey" },
  {
    fixture: "mapped-alias-nested-value",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "mappedKey",
  },
  {
    fixture: "mapped-alias-nested-mapped-value",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "mappedKey",
  },
  {
    fixture: "readonly-array-mapped-alias-wrapped",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "readonlyArray",
  },
  {
    fixture: "readonly-array-mapped-type",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "readonlyArray",
  },
  {
    fixture: "readonly-array-mapped-type-any-value",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "readonlyArray",
  },
  {
    fixture: "readonly-array-mapped-type-as-clause",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "readonlyArray",
  },
  {
    fixture: "readonly-array-mapped-type-key-no-default",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "readonlyArray",
  },
  {
    fixture: "readonly-array-mapped-type-literal-key",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "readonlyArray",
  },
  {
    fixture: "readonly-array-mapped-type-non-optional",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "readonlyArray",
  },
  {
    fixture: "readonly-array-mapped-type-number-key",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "readonlyArray",
  },
  {
    fixture: "readonly-array-mapped-type-plus-optional",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "readonlyArray",
  },
  {
    fixture: "readonly-array-mapped-type-strip-optional",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "readonlyArray",
  },
  {
    fixture: "readonly-array-mapped-type-template-literal-constraint",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "readonlyArray",
  },
  {
    fixture: "readonly-array-mapped-type-union-default",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "readonlyArray",
  },
  {
    fixture: "readonly-array-mapped-type-value-no-default",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "readonlyArray",
  },
  {
    fixture: "readonly-array-mapped-type-with-concrete-props",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "readonlyArray",
  },
  {
    fixture: "type-cycle-recursive-resolution",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "recursive",
  },
];

/** Classes and callable signatures. */
export const callableFixtures: readonly SuiteFixture[] = [
  {
    fixture: "class-members-visibility-and-signatures",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "class",
  },
  {
    fixture: "class-method-generic-signatures",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "method",
  },
  {
    fixture: "class-method-overload-signatures",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "method",
  },
  {
    fixture: "class-private-members-type-alias-filtering",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "class",
  },
  {
    fixture: "function-callable-intersection-extra-properties",
    file: "input.tsx",
    oracle: "immutable-upstream",
    family: "callable",
  },
  {
    fixture: "function-declaration-expression-arrow",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "callable",
  },
  {
    fixture: "jsdoc-comments-and-overloads",
    file: "input.tsx",
    oracle: "immutable-upstream",
    family: "overload",
  },
  {
    fixture: "merged-interface-signature-typeparams",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "overload",
  },
  {
    fixture: "module-reexport-imported-class-type",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "class",
  },
];

/** Generic resolution and substitution. */
export const genericFixtures: readonly SuiteFixture[] = [
  {
    fixture: "generic-argument-alias-resolution",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "alias",
  },
  {
    fixture: "generic-callback-alias-constraint-deduplication",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "deduplication",
  },
  {
    fixture: "generic-callback-alias-renamed-typeparams",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "renaming",
  },
  {
    fixture: "generic-callback-alias-vs-inline-deduplication",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "deduplication",
  },
  {
    fixture: "generic-callback-constraint-property-keys",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "constraint",
  },
  {
    fixture: "generic-callback-default-deduplication",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "default",
  },
  {
    fixture: "generic-callback-nested-shadow-deduplication",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "shadowing",
  },
  {
    fixture: "generic-constraint-tostring-collapse",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "constraint",
  },
  {
    fixture: "generic-default-argument-resolution",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "default",
  },
  {
    fixture: "generic-function-and-interface-resolution",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "substitution",
  },
  {
    fixture: "interface-method-generic-signatures",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "method",
  },
  {
    fixture: "type-alias-generic-argument-resolution",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "alias",
  },
  { fixture: "type-alias-basic-resolution", file: "input.ts", oracle: "reviewed-ts7", family: "alias" },
  {
    fixture: "type-reference-vs-inline-resolution",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "alias",
  },
];

/** Mapped types. */
export const mappedTypeFixtures: readonly SuiteFixture[] = [
  {
    fixture: "external-mapped-type-name-preservation",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "external",
  },
  {
    fixture: "mapped-type-builtin-utility-resolution",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "modifiers",
  },
  {
    fixture: "mapped-type-optional-aliased-unknown",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "openDomain",
  },
];

/** Preserved type operators. */
export const typeOperatorFixtures: readonly SuiteFixture[] = [
  {
    fixture: "type-alias-export-preservation",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "alias",
  },
  {
    fixture: "type-conditional-return-and-props",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "conditional",
  },
  {
    fixture: "type-extract-utility-resolution",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "conditional",
  },
  { fixture: "type-literal-union-resolution", file: "input.ts", oracle: "reviewed-ts7", family: "keyof" },
  {
    fixture: "unresolved-indexed-access-fallback",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "indexedAccess",
  },
];

/** Module surfaces and re-exports. */
export const moduleSurfaceFixtures: readonly SuiteFixture[] = [
  {
    fixture: "interface-merged-default-and-aliased-exports",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "mergedDeclarations",
  },
  { fixture: "module-reexports-basic", file: "input.ts", oracle: "immutable-upstream", family: "reexports" },
  {
    fixture: "namespace-callback-alias-resolution",
    file: "input.tsx",
    oracle: "immutable-upstream",
    family: "namespaces",
  },
  {
    fixture: "namespace-nested-alias-resolution",
    file: "input.tsx",
    oracle: "immutable-upstream",
    family: "namespaces",
  },
  { fixture: "namespace-export-resolution", file: "input.tsx", oracle: "reviewed-ts7", family: "namespaces" },
];

/** React component recognition. */
export const reactRecognitionFixtures: readonly SuiteFixture[] = [
  {
    fixture: "react-component-function-declaration",
    file: "input.tsx",
    oracle: "immutable-upstream",
    family: "declaration",
  },
  {
    fixture: "react-component-function-variable",
    file: "input.tsx",
    oracle: "immutable-upstream",
    family: "variable",
  },
  {
    fixture: "react-component-return-types",
    file: "input.tsx",
    oracle: "immutable-upstream",
    family: "returnTypes",
  },
  {
    fixture: "react-component-function-overloads",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "componentOverloads",
  },
  {
    fixture: "react-component-generic-function-overloads",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "componentOverloads",
  },
  { fixture: "react-props-callback-types", file: "input.tsx", oracle: "immutable-upstream", family: "props" },
  { fixture: "react-props-literal-types", file: "input.tsx", oracle: "immutable-upstream", family: "props" },
  { fixture: "react-props-optional-types", file: "input.tsx", oracle: "immutable-upstream", family: "props" },
  {
    fixture: "react-hook-multiple-parameters",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "hooks",
  },
  {
    fixture: "react-hook-overload-signatures",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "hooks",
  },
];

/** React wrapper provenance and warnings. */
export const reactWrapperFixtures: readonly SuiteFixture[] = [
  {
    fixture: "react-forward-ref-component",
    file: "input.tsx",
    oracle: "immutable-upstream",
    family: "forwardRef",
  },
  {
    fixture: "react-forward-ref-union-props",
    file: "input.tsx",
    oracle: "reviewed-ts7",
    family: "forwardRefUnion",
  },
  { fixture: "react-memo-component", file: "input.tsx", oracle: "immutable-upstream", family: "memo" },
  {
    fixture: "react-mui-overridable-component",
    file: "input.d.ts",
    oracle: "reviewed-ts7",
    family: "overridable",
  },
];

/** External type selection and warnings. */
export const externalTypeFixtures: readonly SuiteFixture[] = [
  {
    fixture: "external-conditional-type-resolution",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "externalConditional",
  },
  {
    fixture: "external-union-type-name-preservation",
    file: "input.ts",
    oracle: "reviewed-ts7",
    family: "externalUnions",
  },
  {
    fixture: "generic-props-namespace-specialization",
    file: "input.ts",
    oracle: "reviewed-ts7",
    family: "namespaceSpecialization",
  },
  {
    fixture: "interface-extends-namespace-and-omit-resolution",
    file: "input.ts",
    oracle: "reviewed-ts7",
    family: "heritageOmit",
  },
  { fixture: "module-export-forms", file: "input.tsx", oracle: "reviewed-ts7", family: "exportForms" },
  {
    fixture: "module-reexports-aliased-source-tracking",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "reexportTracking",
  },
  {
    fixture: "module-reexports-parts-namespace",
    file: "input.ts",
    oracle: "reviewed-ts7",
    family: "reexportNamespaces",
  },
  {
    fixture: "react-component-overload-any-callback-deduplication",
    file: "input.tsx",
    oracle: "reviewed-ts7",
    family: "overloadDeduplication",
  },
  {
    fixture: "react-component-render-callback-props",
    file: "input.tsx",
    oracle: "reviewed-ts7",
    family: "renderCallbacks",
  },
  {
    fixture: "react-component-union-variants",
    file: "input.tsx",
    oracle: "reviewed-ts7",
    family: "componentUnions",
  },
  { fixture: "react-event-handlers", file: "input.ts", oracle: "immutable-upstream", family: "handlers" },
  { fixture: "react-hook-arrow-function", file: "input.ts", oracle: "immutable-upstream", family: "hooks" },
  {
    fixture: "react-hook-function-declaration",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "hooks",
  },
  {
    fixture: "react-hook-function-expression",
    file: "input.ts",
    oracle: "immutable-upstream",
    family: "hooks",
  },
  { fixture: "react-refs", file: "input.tsx", oracle: "reviewed-ts7", family: "refs" },
];

/** Every React fixture audited for wrapper provenance, in audit order. */
export const reactFixtureAudit: readonly (SuiteFixture & { readonly owner: string })[] = [
  {
    fixture: "react-component-function-declaration",
    file: "input.tsx",
    oracle: "immutable-upstream",
    owner: "issue11",
  },
  {
    fixture: "react-component-function-variable",
    file: "input.tsx",
    oracle: "immutable-upstream",
    owner: "issue11",
  },
  {
    fixture: "react-component-return-types",
    file: "input.tsx",
    oracle: "immutable-upstream",
    owner: "issue11",
  },
  {
    fixture: "react-component-function-overloads",
    file: "input.ts",
    oracle: "immutable-upstream",
    owner: "issue11",
  },
  {
    fixture: "react-component-generic-function-overloads",
    file: "input.ts",
    oracle: "immutable-upstream",
    owner: "issue11",
  },
  {
    fixture: "react-component-overload-any-callback-deduplication",
    file: "input.tsx",
    oracle: "reviewed-ts7",
    owner: "issue13",
  },
  {
    fixture: "react-component-render-callback-props",
    file: "input.tsx",
    oracle: "reviewed-ts7",
    owner: "issue13",
  },
  { fixture: "react-component-union-variants", file: "input.tsx", oracle: "reviewed-ts7", owner: "issue13" },
  { fixture: "react-event-handlers", file: "input.ts", oracle: "immutable-upstream", owner: "issue13" },
  { fixture: "react-hook-arrow-function", file: "input.ts", oracle: "immutable-upstream", owner: "issue13" },
  {
    fixture: "react-hook-function-declaration",
    file: "input.ts",
    oracle: "immutable-upstream",
    owner: "issue13",
  },
  {
    fixture: "react-hook-function-expression",
    file: "input.ts",
    oracle: "immutable-upstream",
    owner: "issue13",
  },
  {
    fixture: "react-hook-multiple-parameters",
    file: "input.ts",
    oracle: "immutable-upstream",
    owner: "issue11",
  },
  {
    fixture: "react-hook-overload-signatures",
    file: "input.ts",
    oracle: "immutable-upstream",
    owner: "issue11",
  },
  {
    fixture: "react-props-callback-types",
    file: "input.tsx",
    oracle: "immutable-upstream",
    owner: "issue11",
  },
  { fixture: "react-props-literal-types", file: "input.tsx", oracle: "immutable-upstream", owner: "issue11" },
  {
    fixture: "react-props-optional-types",
    file: "input.tsx",
    oracle: "immutable-upstream",
    owner: "issue11",
  },
  { fixture: "react-refs", file: "input.tsx", oracle: "reviewed-ts7", owner: "issue13" },
  {
    fixture: "react-forward-ref-component",
    file: "input.tsx",
    oracle: "immutable-upstream",
    owner: "issue12",
  },
  { fixture: "react-forward-ref-union-props", file: "input.tsx", oracle: "reviewed-ts7", owner: "issue12" },
  { fixture: "react-memo-component", file: "input.tsx", oracle: "immutable-upstream", owner: "issue12" },
  {
    fixture: "react-mui-overridable-component",
    file: "input.d.ts",
    oracle: "reviewed-ts7",
    owner: "issue12",
  },
  { fixture: "base-ui-component", file: "input.tsx", oracle: "reviewed-ts7", owner: "issue12" },
];
