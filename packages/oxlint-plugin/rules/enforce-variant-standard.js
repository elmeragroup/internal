// Adapted from kumo lint/enforce-variant-standard.js (MIT, Copyright (c) 2026 Cloudflare, Inc.).
//
// Component entries with a named tv() recipe that has axes must connect that recipe to
// props through a local type: VariantProps imported from "tailwind-variants" (any local
// name) applied to typeof <that recipe>, on an exported type/interface or a function
// parameter annotation, directly or through local aliases, interfaces, and intersections.
// Unsupported: comments, unused imports, strings, a different recipe, helpers not imported
// from "tailwind-variants", namespace imports, forwardRef/FC generics without a parameter
// annotation, Parameters/ReturnType/indexed access, Omit/Pick wrappers, and types imported
// from another file.
import { defineRule } from "@oxlint/plugins";

import { normalizeFilename } from "../filename-normalizer.js";
import { collectProvenRecipes, isModuleLevelType, recordTypeDeclaration } from "../variant-props-proof.js";

/**
 * Component entry: src/components/<name>/<name>.tsx
 * @param {string} filename
 */
function isComponentEntry(filename) {
  return /(?:^|\/)src\/components\/([^/]+)\/\1\.tsx$/.test(normalizeFilename(filename));
}

/**
 * Colocated recipe module: src/components/<name>/<name>-variants.ts
 * @param {string} filename
 */
function isVariantsModule(filename) {
  return /(?:^|\/)src\/components\/([^/]+)\/\1-variants\.ts$/.test(normalizeFilename(filename));
}

/**
 * @param {import("estree").Node | null | undefined} callee
 */
function isTvCall(callee) {
  return callee?.type === "Identifier" && callee.name === "tv";
}

/**
 * @param {import("estree").CallExpression} call
 * @returns {string | null}
 */
function recipeBindingName(call) {
  const parent = call.parent;
  return parent?.type === "VariableDeclarator" && parent.id.type === "Identifier" ? parent.id.name : null;
}

/**
 * @param {import("estree").ObjectExpression} obj
 * @param {string} name
 */
function getObjectProp(obj, name) {
  for (const prop of obj.properties) {
    if (prop.type !== "Property" || prop.computed) continue;
    const key =
      prop.key.type === "Identifier"
        ? prop.key.name
        : prop.key.type === "Literal"
          ? String(prop.key.value)
          : null;
    if (key === name) return prop.value;
  }
  return undefined;
}

/**
 * A recipe has axes when `variants` is present and not an empty object.
 * Identifiers and spreads count as axes; we cannot see through them.
 *
 * @param {import("estree").ObjectExpression} obj
 */
function recipeHasAxes(obj) {
  const variants = getObjectProp(obj, "variants");
  if (!variants) return false;
  if (variants.type !== "ObjectExpression") return true;
  return variants.properties.length > 0;
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Enforce tv recipe structure: named recipe, variants/defaultVariants on recipes with axes, VariantProps typing",
    },
    messages: {
      unnamedRecipe: "tv() recipes must be assigned to a named const (e.g. buttonVariants).",
      inlineObject: "tv() must receive an inline object.",
      missingDefaultVariants:
        "tv() recipe '{{name}}' must declare defaultVariants when it has a variants axis.",
      missingVariantProps:
        "Component files that define a tv() recipe with axes must type props with VariantProps<typeof recipe>.",
    },
    schema: [],
  },
  defaultOptions: [],
  createOnce(context) {
    let shouldCheck = false;
    let requireVariantProps = false;
    /** @type {import("estree").CallExpression[]} */
    const tvCalls = [];
    /** @type {Set<string>} */
    const helperNames = new Set();
    /** @type {Map<string, import("estree").Node[]>} */
    const typeDeclarations = new Map();
    /** @type {Set<string>} */
    const exportedNames = new Set();
    /** @type {import("estree").Node[]} */
    const parameterTypes = [];

    /**
     * @param {import("estree").Node} node
     */
    function visitTypeDeclaration(node) {
      if (!shouldCheck || !isModuleLevelType(node)) return;
      const name = node.id?.name;
      if (typeof name !== "string") return;
      recordTypeDeclaration(name, typeDeclarations, node);
      if (node.parent?.type === "ExportNamedDeclaration") exportedNames.add(name);
    }

    /**
     * @param {import("estree").Node} node
     */
    function visitFunction(node) {
      if (!shouldCheck) return;
      const annotation = node.params?.[0]?.typeAnnotation?.typeAnnotation;
      if (annotation) parameterTypes.push(annotation);
    }

    return {
      Program() {
        const filename = context.filename;
        shouldCheck = isComponentEntry(filename) || isVariantsModule(filename);
        requireVariantProps = isComponentEntry(filename);
        tvCalls.length = 0;
        helperNames.clear();
        typeDeclarations.clear();
        exportedNames.clear();
        parameterTypes.length = 0;
      },
      ImportDeclaration(node) {
        if (!shouldCheck || node.source.value !== "tailwind-variants") return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") continue;
          if (specifier.imported.type === "Identifier" && specifier.imported.name === "VariantProps") {
            helperNames.add(specifier.local.name);
          }
        }
      },
      TSTypeAliasDeclaration(node) {
        visitTypeDeclaration(node);
      },
      TSInterfaceDeclaration(node) {
        visitTypeDeclaration(node);
      },
      ExportNamedDeclaration(node) {
        if (!shouldCheck || node.declaration !== null) return;
        for (const specifier of node.specifiers) {
          if (specifier.local.type === "Identifier") exportedNames.add(specifier.local.name);
        }
      },
      FunctionDeclaration(node) {
        visitFunction(node);
      },
      FunctionExpression(node) {
        visitFunction(node);
      },
      ArrowFunctionExpression(node) {
        visitFunction(node);
      },
      CallExpression(node) {
        if (!shouldCheck || !isTvCall(node.callee)) return;
        tvCalls.push(node);
      },
      "Program:exit"() {
        if (!shouldCheck || tvCalls.length === 0) return;

        /** @type {Array<{ name: string, node: import("estree").CallExpression }>} */
        const axesRecipes = [];
        for (const node of tvCalls) {
          const named = recipeBindingName(node);
          if (!named) {
            context.report({ node, messageId: "unnamedRecipe" });
            continue;
          }

          const firstArg = node.arguments[0];
          if (firstArg?.type !== "ObjectExpression") {
            context.report({ node, messageId: "inlineObject" });
            continue;
          }

          if (!recipeHasAxes(firstArg)) continue;

          if (!getObjectProp(firstArg, "defaultVariants")) {
            context.report({
              node,
              messageId: "missingDefaultVariants",
              data: { name: named },
            });
          }
          axesRecipes.push({ name: named, node });
        }

        if (!requireVariantProps || axesRecipes.length === 0) return;

        /** @type {Set<string>} */
        const proven = new Set();
        const collectCtx = { helperNames, typeDeclarations };
        for (const name of exportedNames) {
          const decls = typeDeclarations.get(name);
          if (!decls) continue;
          const visited = new Set();
          for (const decl of decls) collectProvenRecipes(decl, collectCtx, visited, proven);
        }
        for (const typeNode of parameterTypes) {
          collectProvenRecipes(typeNode, collectCtx, new Set(), proven);
        }

        const uncovered = axesRecipes.find((entry) => !proven.has(entry.name));
        if (uncovered) {
          context.report({
            node: uncovered.node,
            messageId: "missingVariantProps",
          });
        }
      },
    };
  },
});
