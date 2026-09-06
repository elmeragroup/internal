// Adapted from kumo lint/enforce-variant-standard.js (MIT, Copyright (c) 2026 Cloudflare, Inc.).
import { defineRule } from "@oxlint/plugins";

import { normalizeFilename } from "../filename-normalizer.js";

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

    return {
      Program() {
        const filename = context.filename;
        shouldCheck = isComponentEntry(filename) || isVariantsModule(filename);
        requireVariantProps = isComponentEntry(filename);
        tvCalls.length = 0;
      },
      CallExpression(node) {
        if (!shouldCheck || !isTvCall(node.callee)) return;
        tvCalls.push(node);
      },
      "Program:exit"() {
        if (!shouldCheck || tvCalls.length === 0) return;

        for (const node of tvCalls) {
          const parent = node.parent;
          const named =
            parent?.type === "VariableDeclarator" && parent.id.type === "Identifier" ? parent.id.name : null;

          if (!named) {
            context.report({ node, messageId: "unnamedRecipe" });
            continue;
          }

          const firstArg = node.arguments[0];
          if (firstArg?.type !== "ObjectExpression") {
            context.report({ node, messageId: "inlineObject" });
            continue;
          }

          if (recipeHasAxes(firstArg) && !getObjectProp(firstArg, "defaultVariants")) {
            context.report({
              node,
              messageId: "missingDefaultVariants",
              data: { name: named },
            });
          }
        }

        const anyHasAxes = tvCalls.some((call) => {
          const arg = call.arguments[0];
          return arg?.type === "ObjectExpression" && recipeHasAxes(arg);
        });
        if (requireVariantProps && anyHasAxes && !context.sourceCode.getText().includes("VariantProps")) {
          context.report({
            loc: tvCalls[0]?.loc,
            messageId: "missingVariantProps",
          });
        }
      },
    };
  },
});
