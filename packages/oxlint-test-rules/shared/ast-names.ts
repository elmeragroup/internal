import type { ESTree } from "@oxlint/plugins";

import { unwrap } from "./ast-walk.ts";
import { constantString } from "./static-text.ts";

/** A node that may spell a name: an expression, a type name, or a JSX tag or attribute name. */
type NameNode =
  | ESTree.Node
  | ESTree.JSXElementName
  | ESTree.JSXMemberExpressionObject
  | ESTree.JSXAttributeName;

/**
 * A dotted name's identifiers, outermost first: `Base.Dialog.Root` in code, a type or a JSX tag
 * gives `["Base", "Dialog", "Root"]`. A namespaced JSX name such as `xlink:href` is one segment.
 *
 * @param node - An identifier, a member read, a qualified type name or a JSX name.
 * @returns The segments, or `undefined` past a computed or call step. A JSX name always has them.
 */
export function nameChain(node: ESTree.JSXElementName | ESTree.JSXAttributeName): string[];
export function nameChain(node: NameNode): string[] | undefined;
export function nameChain(node: NameNode): string[] | undefined {
  switch (node.type) {
    case "Identifier":
    case "JSXIdentifier":
      return [node.name];
    case "JSXNamespacedName":
      return [`${node.namespace.name}:${node.name.name}`];
    case "MemberExpression": {
      if (node.computed || node.property.type !== "Identifier") return undefined;
      const object = nameChain(node.object);
      return object === undefined ? undefined : [...object, node.property.name];
    }
    case "JSXMemberExpression":
      return [...nameChain(node.object), node.property.name];
    case "TSQualifiedName": {
      const left = nameChain(node.left);
      return left === undefined ? undefined : [...left, node.right.name];
    }
    default:
      return undefined;
  }
}

/**
 * A property or member key's static name: `isDisabled` for `isDisabled: …` or `a.isDisabled`,
 * `data-slot` for `"data-slot": …`, `["data-slot"]: …` or `` [`data-slot`]: … ``, and `0` for
 * `0: …` or `a[0]`. A computed identifier such as `[key]` names nothing.
 *
 * @param property - A property, or a member read's key.
 * @returns The key's name, or `undefined` for one only a run could know.
 */
export function propertyKeyName(property: {
  readonly key: ESTree.PropertyKey | ESTree.Expression | ESTree.PrivateIdentifier;
  readonly computed: boolean;
}): string | undefined {
  const key = property.key;
  if (key.type === "Identifier") return property.computed ? undefined : key.name;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- ESTree tags every literal kind `Literal`; the value's type is the only tag a numeric key has
  if (key.type === "Literal" && typeof key.value === "number") return String(key.value);
  return constantString(key);
}

/**
 * The name an import or export specifier spells: `a` for `{ a }`, `"a-b"` for `{ "a-b" as c }`.
 *
 * @param name - A specifier's imported, local or exported name.
 * @returns The name as written.
 */
export function moduleExportName(name: ESTree.ModuleExportName): string {
  return name.type === "Literal" ? name.value : name.name;
}

/**
 * The key a member read names statically: `x` for `a.x`, `a["x"]` or `` a[`x`] ``, `0` for `a[0]`.
 *
 * @param member - Any node.
 * @returns The key, or `undefined` for anything but a static member read.
 */
export function memberName(member: ESTree.Node): string | undefined {
  const expression = unwrap(member);
  return expression.type === "MemberExpression"
    ? propertyKeyName({ key: expression.property, computed: expression.computed })
    : undefined;
}
