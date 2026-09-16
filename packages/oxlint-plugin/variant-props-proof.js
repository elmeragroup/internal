/** @import { ESTree } from "@oxlint/plugins" */

/**
 * Module-level type aliases, interfaces, and heritage walking for VariantProps proof.
 */

/**
 * Whether a type declaration is owned by the module rather than by a function,
 * class, or block scope.
 *
 * @param {ESTree.Node | null | undefined} node - The declaration node.
 * @returns {boolean} `true` when the declaration sits at the program top level.
 */
export function isModuleLevelType(node) {
  const parent = node?.parent;
  if (!parent) return false;
  if (parent.type === "Program") return true;
  return parent.type === "ExportNamedDeclaration" && parent.parent.type === "Program";
}

/**
 * Append a declaration under its type name in the module-level declaration index.
 *
 * @param {string} name - The declared type name.
 * @param {Map<string, ESTree.Node[]>} typeDeclarations - The index to update.
 * @param {ESTree.Node} node - The declaration node.
 */
export function recordTypeDeclaration(name, typeDeclarations, node) {
  const existing = typeDeclarations.get(name);
  if (existing) existing.push(node);
  else typeDeclarations.set(name, [node]);
}

/**
 * Whether an enclosing type-parameter list shadows a type name before the walk
 * reaches module scope. Shadowed names must not resolve to module declarations.
 *
 * @param {string} name - The referenced type name.
 * @param {ESTree.Node} fromNode - The reference node to walk outward from.
 * @returns {boolean} `true` when a type parameter of the same name is in scope.
 */
function isShadowedTypeName(name, fromNode) {
  let current = fromNode.parent;
  while (current && current.type !== "Program") {
    const params = "typeParameters" in current ? current.typeParameters?.params : undefined;
    if (params) {
      for (const param of params) {
        if (param.name.name === name) return true;
      }
    }
    current = current.parent;
  }
  return false;
}

/**
 * Shared VariantProps proof for a direct type reference and an interface heritage clause.
 *
 * @param {{ name?: ESTree.Node | null, typeArguments?: { params?: ESTree.Node[] } | null } | null | undefined} ref - The type reference to inspect.
 * @param {Set<string>} helperNames - The VariantProps helper names in scope.
 * @returns {string | null} The proven recipe name, or `null` when the reference proves nothing.
 */
function provesRecipe(ref, helperNames) {
  const typeName = ref?.name;
  if (typeName?.type !== "Identifier" || !helperNames.has(typeName.name)) return null;
  const firstArg = ref?.typeArguments?.params?.[0];
  if (firstArg?.type !== "TSTypeQuery") return null;
  const exprName = firstArg.exprName;
  if (exprName.type !== "Identifier") return null;
  return exprName.name;
}

/**
 * @param {ESTree.Node | null | undefined} typeNode
 * @returns {{ name?: ESTree.Node | null, typeArguments?: { params?: ESTree.Node[] } | null } | null}
 */
function typeReferenceOf(typeNode) {
  if (typeNode?.type !== "TSTypeReference") return null;
  return { name: typeNode.typeName, typeArguments: typeNode.typeArguments };
}

/**
 * @param {ESTree.TSInterfaceHeritage} heritage
 * @returns {{ name?: ESTree.Node | null, typeArguments?: { params?: ESTree.Node[] } | null }}
 */
function heritageReferenceOf(heritage) {
  return { name: heritage.expression, typeArguments: heritage.typeArguments };
}

/**
 * Collect every recipe name proven by a type node, following module-level aliases
 * and interface heritage until a VariantProps helper is found or the chain ends.
 *
 * @param {ESTree.Node | null | undefined} typeNode - The type node to walk.
 * @param {{ helperNames: Set<string>, typeDeclarations: Map<string, ESTree.Node[]> }} ctx - Module-level proof context.
 * @param {Set<ESTree.Node>} visited - Declarations already walked, to break cycles.
 * @param {Set<string>} out - Accumulator for proven recipe names.
 */
export function collectProvenRecipes(typeNode, ctx, visited, out) {
  if (!typeNode) return;

  if (typeNode.type === "TSTypeAliasDeclaration") {
    if (visited.has(typeNode)) return;
    visited.add(typeNode);
    collectProvenRecipes(typeNode.typeAnnotation, ctx, visited, out);
    return;
  }

  if (typeNode.type === "TSInterfaceDeclaration") {
    if (visited.has(typeNode)) return;
    visited.add(typeNode);
    for (const heritage of typeNode.extends) {
      const proven = provesRecipe(heritageReferenceOf(heritage), ctx.helperNames);
      if (proven !== null) {
        out.add(proven);
        continue;
      }
      if (heritage.typeArguments != null) continue;
      const expression = heritage.expression;
      if (expression.type !== "Identifier") continue;
      if (isShadowedTypeName(expression.name, heritage)) continue;
      const decls = ctx.typeDeclarations.get(expression.name);
      if (!decls) continue;
      for (const decl of decls) collectProvenRecipes(decl, ctx, visited, out);
    }
    return;
  }

  const typeRef = typeReferenceOf(typeNode);
  if (typeRef !== null) {
    const proven = provesRecipe(typeRef, ctx.helperNames);
    if (proven !== null) {
      out.add(proven);
      return;
    }
  }

  if (typeNode.type === "TSIntersectionType") {
    for (const member of typeNode.types) {
      collectProvenRecipes(member, ctx, visited, out);
    }
    return;
  }

  if (typeNode.type !== "TSTypeReference") return;
  const typeName = typeNode.typeName;
  if (typeName.type !== "Identifier" || typeNode.typeArguments != null) return;
  if (isShadowedTypeName(typeName.name, typeNode)) return;
  const decls = ctx.typeDeclarations.get(typeName.name);
  if (!decls) return;
  for (const decl of decls) collectProvenRecipes(decl, ctx, visited, out);
}
