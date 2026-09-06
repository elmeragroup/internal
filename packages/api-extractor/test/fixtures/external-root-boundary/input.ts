/**
 * Workspace-owned regression fixture for the Issue 13 export-root boundary.
 * Both declarations originate in a vendored dependency, but their bare
 * interface/value roots intentionally remain anonymous empty objects under the
 * current TypeScript 7 policy.
 */
export type { BareInterface } from "external-root-dependency";
export { bareValue } from "external-root-dependency";

export type { Array as ProjectArray } from "./src/typescript/lib/lib.dom.js";
export type { ReadonlyArray as ProjectReadonlyArray } from "./src/@typescript/tsc/lib/lib.es2022.js";

export type ProjectArrayUse = import("./src/typescript/lib/lib.dom.js").Array<string>;
export type ProjectReadonlyArrayUse = import("./src/@typescript/tsc/lib/lib.es2022.js").ReadonlyArray<string>;
export type ProjectExtractUse = import("./src/typescript/lib/lib.dom.js").Extract<
  keyof { value: string; other: boolean },
  string
>;

// A project-owned generic is intentionally shaped like the checker-generated
// namespace substitution used by external library references. Its concrete
// argument is declared at the top level, so the argument must not inherit
// Outer's namespace merely because the enclosing alias does.
namespace Outer {
  export interface Box<T> {
    value: T;
  }

  export interface Local {
    marker: string;
  }
}

interface Local {
  marker: string;
}

type OuterAlias<T> = Outer.Box<T>;

export type ProjectNamespaceSubstitution = {
  wrapped: OuterAlias<Local>;
};

interface Holder<T> {
  ref: import("external-root-dependency").React.Ref<T>;
}

export type ProjectNestedNamespaceSubstitution = Holder<Outer.Local>;
