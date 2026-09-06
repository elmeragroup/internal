import { defineRule } from "@oxlint/plugins";

import { normalizeFilename } from "../filename-normalizer.js";

const MESSAGE =
  "Direct process.env access is forbidden except the process.env.NODE_ENV comparison in the theme validator module.";

const ALLOWED_VALIDATOR_SUFFIX = "/src/theme/validate-theme.ts";

/**
 * @param {import("estree").Node | null | undefined} node
 * @returns {node is import("estree").Identifier}
 */
function isProcessIdentifier(node) {
  return node?.type === "Identifier" && node.name === "process";
}

/**
 * @param {import("estree").Node | null | undefined} node
 * @param {boolean} isComputed
 */
function isEnvProperty(node, isComputed) {
  if (!isComputed) {
    return node?.type === "Identifier" && node.name === "env";
  }

  return node?.type === "Literal" && node.value === "env";
}

/**
 * @param {import("estree").Node | null | undefined} node
 * @returns {node is import("estree").MemberExpression}
 */
function isProcessEnvMemberExpression(node) {
  return (
    node?.type === "MemberExpression" &&
    isProcessIdentifier(node.object) &&
    isEnvProperty(node.property, node.computed)
  );
}

/**
 * @param {import("estree").Node | null | undefined} node
 * @param {boolean} isComputed
 */
function isNodeEnvProperty(node, isComputed) {
  if (!isComputed) {
    return node?.type === "Identifier" && node.name === "NODE_ENV";
  }

  return node?.type === "Literal" && node.value === "NODE_ENV";
}

/**
 * @param {import("estree").MemberExpression} processEnvNode
 */
function isProcessEnvNodeEnv(processEnvNode) {
  const parent = processEnvNode.parent;
  return (
    parent?.type === "MemberExpression" &&
    parent.object === processEnvNode &&
    isNodeEnvProperty(parent.property, parent.computed)
  );
}

/**
 * @param {string} operator
 */
function isComparisonOperator(operator) {
  return operator === "===" || operator === "!==" || operator === "==" || operator === "!=";
}

/**
 * @param {import("estree").MemberExpression} processEnvNode
 */
function isNodeEnvComparison(processEnvNode) {
  if (!isProcessEnvNodeEnv(processEnvNode)) {
    return false;
  }

  const nodeEnv = processEnvNode.parent;
  const comparison = nodeEnv.parent;
  return comparison?.type === "BinaryExpression" && isComparisonOperator(comparison.operator);
}

/**
 * @param {string} filename
 */
function isThemeValidatorModule(filename) {
  return normalizeFilename(filename).endsWith(ALLOWED_VALIDATOR_SUFFIX);
}

export default defineRule({
  createOnce(context) {
    return {
      /** @param {import("estree").MemberExpression} node */
      MemberExpression(node) {
        if (!isProcessEnvMemberExpression(node)) {
          return;
        }

        if (isThemeValidatorModule(context.filename) && isNodeEnvComparison(node)) {
          return;
        }

        context.report({
          loc: node.loc,
          messageId: "restrictedAccess",
        });
      },
    };
  },

  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow direct process.env access except the process.env.NODE_ENV comparison in the theme validator",
    },
    schema: [],
    messages: {
      restrictedAccess: MESSAGE,
    },
  },
});
