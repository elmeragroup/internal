/**
 * Module-level type aliases, interfaces, and heritage walking for VariantProps proof.
 */

/**
 * @param {import("estree").Node | null | undefined} node
 */
export function isModuleLevelType(node) {
  const parent = node?.parent;
  if (!parent) return false;
  if (parent.type === "Program") return true;
  return parent.type === "ExportNamedDeclaration" && parent.parent?.type === "Program";
}

/**
 * @param {string} name
 * @param {Map<string, import("estree").Node[]>} typeDeclarations
 * @param {import("estree").Node} node
 */
export function recordTypeDeclaration(name, typeDeclarations, node) {
  const existing = typeDeclarations.get(name);
  if (existing) existing.push(node);
  else typeDeclarations.set(name, [node]);
}

/**
 * @param {string} name
 * @param {import("estree").Node} fromNode
 */
export function isShadowedTypeName(name, fromNode) {
  let current = fromNode.parent;
  while (current && current.type !== "Program") {
    const params = current.typeParameters?.params;
    if (params) {
      for (const param of params) {
        if (param?.name?.name === name) return true;
      }
    }
    current = current.parent;
  }
  return false;
}

/**
 * Shared VariantProps proof for a direct type reference and an interface heritage clause.
 *
 * @param {{ name?: import("estree").Node | null, typeArguments?: { params?: import("estree").Node[] } | null } | null | undefined} ref
 * @param {Set<string>} helperNames
 * @returns {string | null}
 */
export function provesRecipe(ref, helperNames) {
  const typeName = ref?.name;
  if (typeName?.type !== "Identifier" || !helperNames.has(typeName.name)) return null;
  const firstArg = ref.typeArguments?.params?.[0];
  if (firstArg?.type !== "TSTypeQuery") return null;
  const exprName = firstArg.exprName;
  if (exprName?.type !== "Identifier") return null;
  return exprName.name;
}

/**
 * @param {import("estree").Node | null | undefined} typeNode
 * @returns {{ name?: import("estree").Node | null, typeArguments?: { params?: import("estree").Node[] } | null } | null}
 */
function typeReferenceOf(typeNode) {
  if (typeNode?.type !== "TSTypeReference") return null;
  return { name: typeNode.typeName, typeArguments: typeNode.typeArguments };
}

/**
 * @param {import("estree").Node} heritage
 * @returns {{ name?: import("estree").Node | null, typeArguments?: { params?: import("estree").Node[] } | null }}
 */
function heritageReferenceOf(heritage) {
  return { name: heritage.expression, typeArguments: heritage.typeArguments };
}

/**
 * @param {import("estree").Node | null | undefined} typeNode
 * @param {{ helperNames: Set<string>, typeDeclarations: Map<string, import("estree").Node[]> }} ctx
 * @param {Set<import("estree").Node>} visited
 * @param {Set<string>} out
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
    for (const heritage of typeNode.extends ?? []) {
      const proven = provesRecipe(heritageReferenceOf(heritage), ctx.helperNames);
      if (proven !== null) {
        out.add(proven);
        continue;
      }
      if (heritage.typeArguments != null) continue;
      const expression = heritage.expression;
      if (expression?.type !== "Identifier") continue;
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
    for (const member of typeNode.types ?? []) {
      collectProvenRecipes(member, ctx, visited, out);
    }
    return;
  }

  if (typeNode.type !== "TSTypeReference") return;
  const typeName = typeNode.typeName;
  if (typeName?.type !== "Identifier" || typeNode.typeArguments != null) return;
  if (isShadowedTypeName(typeName.name, typeNode)) return;
  const decls = ctx.typeDeclarations.get(typeName.name);
  if (!decls) return;
  for (const decl of decls) collectProvenRecipes(decl, ctx, visited, out);
}
