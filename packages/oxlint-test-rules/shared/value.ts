import type { ESTree } from "@oxlint/plugins";

import { functionNameOf } from "./ast-walk.ts";

/**
 * The values `resolve.ts`'s evaluator returns, and the pure operations on them: how alternatives
 * combine, how one value derives from another, and how a callee value names a function. Nothing
 * here reads the file; `resolve.ts` owns the contract of what the evaluator follows.
 */

/** How many alternatives one value keeps before it gives up as `unknown`. */
const MAX_ALTERNATIVES = 64;

/** The global objects a global can be read off without changing what it names. */
export const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(["globalThis", "window", "self"]);

/** A property an object literal alternative sets: its key, its value and the property node. */
export type PropertyEntry = {
  readonly _tag: "property";
  readonly key: string;
  readonly value: ESTree.Node;
  readonly property: ESTree.ObjectProperty;
};

/** One entry of an object literal alternative, in source order. */
export type Entry = PropertyEntry | { readonly _tag: "unopened-spread" };

/**
 * What one alternative is. A global and a member carry the node that read them (`at`): a capture of
 * a value a fake clock later replaces keeps the value it read there.
 */
export type AltBody =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "null" }
  | { readonly kind: "undefined" }
  | { readonly kind: "regex"; readonly pattern: string; readonly flags: string }
  | { readonly kind: "object"; readonly node: ESTree.Node; readonly entries: ReadonlyArray<Entry> }
  | {
      readonly kind: "array";
      readonly node: ESTree.ArrayExpression;
      readonly elements: ReadonlyArray<ESTree.Node | null>;
      readonly complete: boolean;
    }
  | { readonly kind: "function"; readonly fn: ESTree.Node }
  | { readonly kind: "global"; readonly name: string; readonly at: ESTree.Node }
  | { readonly kind: "import"; readonly source: string; readonly imported: string }
  | { readonly kind: "member"; readonly object: Alt; readonly key: string; readonly at: ESTree.Node }
  | { readonly kind: "parameter"; readonly fn: ESTree.Node; readonly index: number }
  | { readonly kind: "loop"; readonly iterable: ESTree.Node }
  | { readonly kind: "opaque"; readonly node: ESTree.Node }
  | { readonly kind: "unknown" };

/**
 * One value an expression may hold: what it is, whether a name reached it (`named`): a binding, a
 * property of a named value, a call's return, or a primitive operation on a named operand; and the
 * local calls whose returns carried it out
 * (`via`), outermost first, so a consumer can judge it at the invocation that produced it.
 */
export type Alt = AltBody & {
  readonly named: boolean;
  readonly via: ReadonlyArray<ESTree.CallExpression>;
};

/**
 * How a value came from another: read off a container (`projection`), returned by a local call
 * (`return`), or read through a binding (`name`).
 */
export type Derivation =
  | { readonly _tag: "projection"; readonly container: Alt }
  | { readonly _tag: "return"; readonly call: ESTree.CallExpression }
  | { readonly _tag: "name" };

/**
 * A value as reached through a derivation: the one way the evaluator marks provenance. A
 * projection is `named` when its container is, and carries its container's calls
 * before its own; a return is `named` and carries the call before its own; a name is `named`.
 *
 * @param value - The value as its own expression holds it.
 * @param derivation - How it was reached.
 * @returns The value with its provenance.
 */
export function derive(value: Alt, derivation: Derivation): Alt {
  switch (derivation._tag) {
    case "projection":
      return {
        ...value,
        named: value.named || derivation.container.named,
        via: [...derivation.container.via, ...value.via],
      };
    case "return":
      return { ...value, named: true, via: [derivation.call, ...value.via] };
    case "name":
      return { ...value, named: true };
  }
}

/**
 * An alternative reached through no name and carried by no call.
 *
 * @param body - What it is.
 * @returns The alternative.
 */
export function plain(body: AltBody): Alt {
  return { ...body, named: false, via: [] };
}

/** A value the evaluator cannot know: never evidence for an exemption or a violation. */
export const UNKNOWN: Alt = plain({ kind: "unknown" });

/** The value `undefined`. */
export const UNDEFINED: Alt = plain({ kind: "undefined" });

/**
 * Alternatives from several sources side by side (a condition's arms, a function's returns),
 * capped: more than the cap is `unknown`.
 *
 * @param lists - Each source's alternatives.
 * @returns All of them, or `[unknown]` past the cap.
 */
export function alternatives(...lists: ReadonlyArray<ReadonlyArray<Alt>>): Alt[] {
  const all = lists.flat();
  return all.length > MAX_ALTERNATIVES ? [UNKNOWN] : all;
}

/**
 * The one way operands combine: `operation` runs on every combination of one alternative per
 * operand, and the results are the operation's alternatives. Past the cap of combinations or
 * results, the result is `overflow` alone.
 *
 * @template T - One operand alternative.
 * @template R - One result.
 * @param operands - Each operand's alternatives, in order.
 * @param operation - The operation on one combination.
 * @param overflow - The result past the cap.
 * @returns The operation's alternatives.
 */
export function product<T, R>(
  operands: ReadonlyArray<ReadonlyArray<T>>,
  operation: (combination: ReadonlyArray<T>) => ReadonlyArray<R>,
  overflow: R
): R[] {
  let combinations: T[][] = [[]];
  for (const operand of operands) {
    combinations = combinations.flatMap((before) => operand.map((choice) => [...before, choice]));
    if (combinations.length > MAX_ALTERNATIVES) return [overflow];
  }
  const results = combinations.flatMap((combination) => operation(combination));
  return results.length > MAX_ALTERNATIVES ? [overflow] : results;
}

/**
 * The evaluator's product: past the cap, `unknown`.
 *
 * @param operands - Each operand's alternatives, in order.
 * @param operation - The operation on one combination.
 * @returns The operation's alternatives.
 */
export function combine(
  operands: ReadonlyArray<ReadonlyArray<Alt>>,
  operation: (combination: ReadonlyArray<Alt>) => ReadonlyArray<Alt>
): Alt[] {
  return product(operands, operation, UNKNOWN);
}

/** A JavaScript primitive the evaluator computes with. */
export type Primitive = string | number | boolean | null | undefined;

/** The primitive an alternative holds, boxed so `undefined` is a value; nothing for another kind. */
function primitiveOf(alternative: Alt): ReadonlyArray<{ readonly value: Primitive }> {
  switch (alternative.kind) {
    case "string":
    case "number":
    case "boolean":
      return [{ value: alternative.value }];
    case "null":
      return [{ value: null }];
    case "undefined":
      return [{ value: undefined }];
    default:
      return [];
  }
}

/**
 * An alternative for a primitive JavaScript value computed from operands: a new value, named when
 * an operand it comes from was, with no call provenance of its own.
 *
 * @param value - The computed value.
 * @param from - The operands it was computed from.
 * @returns The alternative.
 */
export function fromPrimitive(value: Primitive, from: ReadonlyArray<Alt> = []): Alt {
  const isNamed = from.some((operand) => operand.named);
  const body = (): AltBody => {
    if (value === null) return { kind: "null" };
    if (value === undefined) return { kind: "undefined" };
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a computed primitive carries no other tag than its JavaScript type
    if (typeof value === "string") return { kind: "string", value };
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a computed primitive carries no other tag than its JavaScript type
    if (typeof value === "number") return { kind: "number", value };
    return { kind: "boolean", value };
  };
  return { ...body(), named: isNamed, via: [] };
}

/**
 * The values of a combination when every alternative in it is a typed primitive.
 *
 * @param combination - One alternative per operand.
 * @returns The primitives, or `undefined` when one is no typed primitive.
 */
export function primitives(combination: ReadonlyArray<Alt>): Primitive[] | undefined {
  const values = combination.flatMap((alternative) => primitiveOf(alternative).map((boxed) => boxed.value));
  return values.length === combination.length ? values : undefined;
}

/**
 * Whether an alternative is truthy, falsy, or either (a value the evaluator does not hold).
 *
 * @param alternative - One alternative.
 * @returns Its truthiness.
 */
export function truthiness(alternative: Alt): "truthy" | "falsy" | "either" {
  switch (alternative.kind) {
    case "string":
      return alternative.value === "" ? "falsy" : "truthy";
    case "number":
      return alternative.value === 0 || Number.isNaN(alternative.value) ? "falsy" : "truthy";
    case "boolean":
      return alternative.value ? "truthy" : "falsy";
    case "null":
    case "undefined":
      return "falsy";
    case "regex":
    case "object":
    case "array":
    case "function":
      return "truthy";
    default:
      return "either";
  }
}

/**
 * Whether an alternative is `null` or `undefined`, neither, or either (a value the evaluator does
 * not hold).
 *
 * @param alternative - One alternative.
 * @returns Its nullishness.
 */
export function nullishness(alternative: Alt): "nullish" | "present" | "either" {
  if (alternative.kind === "null" || alternative.kind === "undefined") return "nullish";
  return truthiness(alternative) === "either" ? "either" : "present";
}

/**
 * Whether a destructuring or parameter default may apply to a value: it does for `undefined`, and
 * may for a value the evaluator does not hold. `null` keeps its own value, as in JavaScript.
 *
 * @param value - One alternative.
 * @returns Whether the default may apply.
 */
export function mayTakeDefault(value: Alt): boolean {
  return value.kind === "undefined" || nullishness(value) === "either";
}

/**
 * A value with a default applied as JavaScript applies a destructuring or parameter default: the
 * default where an alternative is `undefined`, beside the alternative where it may be (a value the
 * evaluator does not hold), and nothing for an alternative that is never `undefined`.
 *
 * @param values - The value's alternatives.
 * @param fallback - The default's alternatives, read only where needed.
 * @returns The alternatives with the default applied.
 */
export function withDefault(values: ReadonlyArray<Alt>, fallback: () => ReadonlyArray<Alt>): Alt[] {
  return alternatives(
    ...values.map((value): ReadonlyArray<Alt> => {
      if (!mayTakeDefault(value)) return [value];
      return value.kind === "undefined" ? fallback() : [value, ...fallback()];
    })
  );
}

/**
 * The entry that sets a key on an object alternative: its last property with the key, after its
 * spreads; `unknown` when an unopened spread may set it; `undefined` when nothing sets it.
 *
 * @param object - An alternative.
 * @param key - The property key.
 * @returns The setting property, `"unknown"`, or `undefined`.
 */
export function entryFor(object: Alt, key: string): PropertyEntry | "unknown" | undefined {
  if (object.kind !== "object") return "unknown";
  for (let index = object.entries.length - 1; index >= 0; index -= 1) {
    const entry = object.entries[index];
    if (entry === undefined) continue;
    if (entry._tag === "unopened-spread") return "unknown";
    if (entry.key === key) return entry;
  }
  return undefined;
}

/**
 * The strings an expression may be: the value of each alternative that is a string. A consumer
 * that needs every alternative to be a string quantifies the alternatives itself.
 *
 * @param values - An expression's alternatives.
 * @returns The string values.
 */
export function stringValues(values: ReadonlyArray<Alt>): string[] {
  return values.flatMap((alternative) => (alternative.kind === "string" ? [alternative.value] : []));
}

/** A callee as the module that exports it and the names read off it. */
export type CalleeTarget = {
  /** The module it is imported from, or `undefined` for a global or a local value. */
  readonly module: string | undefined;
  /**
   * The names after the module: `["setTimeout"]` for `timers.setTimeout` off `node:timers`. A
   * receiver the evaluator cannot name is `*`, so `createRequire(url).resolve` is `["*", "resolve"]`.
   */
  readonly path: ReadonlyArray<string>;
};

/** A target with one more name read off it; a name off a global object is that global. */
function append(base: CalleeTarget, key: string): CalleeTarget {
  const [only, ...rest] = base.path;
  if (base.module === undefined && rest.length === 0 && only !== undefined && GLOBAL_OBJECTS.has(only)) {
    return { module: undefined, path: [key] };
  }
  return { module: base.module, path: [...base.path, key] };
}

/**
 * The function one alternative names, as the module that exports it and the names read off it:
 * a global, an import, a named local function, or a key read off any of those; a key read off a
 * value with no name is read off `*`.
 *
 * @param alternative - An alternative of a callee.
 * @returns The target, or `undefined` for an alternative that names no function.
 */
export function targetOf(alternative: Alt): CalleeTarget | undefined {
  switch (alternative.kind) {
    case "import":
      return alternative.imported === "*" || alternative.imported === "default"
        ? { module: alternative.source, path: [] }
        : { module: alternative.source, path: [alternative.imported] };
    case "global":
      return { module: undefined, path: [alternative.name] };
    case "function": {
      const name = functionNameOf(alternative.fn);
      return name?.type === "Identifier" ? { module: undefined, path: [name.name] } : undefined;
    }
    case "member":
      return append(targetOf(alternative.object) ?? { module: undefined, path: ["*"] }, alternative.key);
    default:
      return undefined;
  }
}
