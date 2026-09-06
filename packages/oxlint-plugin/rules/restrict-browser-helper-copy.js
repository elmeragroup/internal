import { defineRule } from "@oxlint/plugins";

import { normalizeFilename } from "../filename-normalizer.js";

const HELPERS = new Set([
  "roleNamed",
  "headingNamed",
  "cssVarColor",
  "textNamed",
  "textboxNamed",
  "stampDensity",
  "px",
]);
const OWNER_SUFFIX = "/test/themed-browser-render.tsx";

/**
 * @param {string} filename
 */
function isOwner(filename) {
  return normalizeFilename(filename).endsWith(OWNER_SUFFIX);
}

/**
 * @param {import("estree").Node | null | undefined} id
 * @returns {string | null}
 */
function helperName(id) {
  if (id?.type !== "Identifier" || !HELPERS.has(id.name)) {
    return null;
  }
  return id.name;
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid local declarations of the shared browser-harness helpers (roleNamed, headingNamed, cssVarColor, textNamed, textboxNamed, stampDensity, px) outside packages/ui/test/themed-browser-render.tsx",
    },
    messages: {
      localCopy:
        "Import {{helper}} from packages/ui/test/themed-browser-render.tsx. Suites do not re-declare harness helpers.",
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
      FunctionDeclaration(node) {
        if (skipFile) {
          return;
        }
        const helper = helperName(node.id);
        if (helper === null) {
          return;
        }
        context.report({ node: node.id, messageId: "localCopy", data: { helper } });
      },
      VariableDeclarator(node) {
        if (skipFile) {
          return;
        }
        const helper = helperName(node.id);
        if (helper === null) {
          return;
        }
        context.report({ node: node.id, messageId: "localCopy", data: { helper } });
      },
    };
  },
});
