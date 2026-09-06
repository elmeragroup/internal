import { defineRule } from "@oxlint/plugins";

import { isNamedCall } from "../extract-strings.js";
import { normalizeFilename } from "../filename-normalizer.js";

const OWNER_SUFFIX = "/scripts/paths.ts";

/**
 * @param {string} filename
 */
function isOwner(filename) {
  return normalizeFilename(filename).endsWith(OWNER_SUFFIX);
}

/**
 * @param {import("estree").Node | null | undefined} node
 */
function isImportMetaUrl(node) {
  return (
    node?.type === "MemberExpression" &&
    node.object?.type === "MetaProperty" &&
    node.object.meta?.name === "import" &&
    node.object.property?.name === "meta" &&
    node.property?.type === "Identifier" &&
    node.property.name === "url"
  );
}

/**
 * @param {import("estree").Node | null | undefined} node
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
  defaultOptions: [],
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
