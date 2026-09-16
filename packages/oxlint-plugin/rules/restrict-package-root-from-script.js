import { defineRule } from "@oxlint/plugins";

import { isNamedCall } from "../extract-strings.js";
import { normalizeFilename } from "../filename-normalizer.js";

/** @import { ESTree } from "@oxlint/plugins" */

const OWNER_SUFFIX = "/scripts/paths.ts";

/**
 * @param {string} filename
 */
function isOwner(filename) {
  return normalizeFilename(filename).endsWith(OWNER_SUFFIX);
}

/**
 * @param {ESTree.Node | null | undefined} node
 */
function isImportMetaUrl(node) {
  if (node?.type !== "MemberExpression") return false;
  const { object, property } = node;
  return (
    object.type === "MetaProperty" &&
    object.meta.name === "import" &&
    object.property.name === "meta" &&
    property.type === "Identifier" &&
    property.name === "url"
  );
}

/**
 * @param {ESTree.Node | null | undefined} node
 */
function isFileUrlToPathOfImportMetaUrl(node) {
  return (
    node?.type === "CallExpression" &&
    isNamedCall(node.callee, "fileURLToPath") &&
    node.arguments.length > 0 &&
    isImportMetaUrl(node.arguments[0])
  );
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Forbid dirname(fileURLToPath(import.meta.url)) outside packages/ui/scripts/paths.ts",
    },
    messages: {
      usePackageRootFromScript:
        "Locate the package root with packageRootFromScript(import.meta.url). dirname(fileURLToPath(import.meta.url)) lives only in scripts/paths.ts.",
    },
    schema: [],
  },
  createOnce(context) {
    let skipFile = false;

    return {
      Program() {
        skipFile = isOwner(context.filename);
      },
      CallExpression(node) {
        if (skipFile || !isNamedCall(node.callee, "dirname")) {
          return;
        }
        if (!isFileUrlToPathOfImportMetaUrl(node.arguments[0])) {
          return;
        }
        context.report({ node, messageId: "usePackageRootFromScript" });
      },
    };
  },
});
