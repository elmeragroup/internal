import { defineRule } from "@oxlint/plugins";

import { normalizeFilename } from "../filename-normalizer.js";
import { isForbiddenRacSpecifier } from "../forbidden-rac-packages.js";

/**
 * @param {string} filename
 */
function isReactAriaQuarantine(filename) {
  return normalizeFilename(filename).includes("/src/react-aria/");
}

/**
 * @param {import("estree").Node | null | undefined} source
 * @returns {string | null}
 */
function specifierFromSource(source) {
  if (source?.type === "Literal" && typeof source.value === "string") {
    return source.value;
  }
  return null;
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid react-aria-components, react-aria, @internationalized/date, and the scoped @react-aria/* / @react-stately/* packages outside src/react-aria/**",
    },
    messages: {
      quarantined: "`{{specifier}}` may only be imported from packages/ui/src/react-aria/** (quarantine).",
    },
    schema: [],
  },
  defaultOptions: [],
  createOnce(context) {
    let skipFile = false;

    /**
     * @param {import("estree").Node} node
     * @param {string | null} specifier
     */
    function reportIfForbidden(node, specifier) {
      if (skipFile || specifier === null || !isForbiddenRacSpecifier(specifier)) {
        return;
      }
      context.report({ node, messageId: "quarantined", data: { specifier } });
    }

    return {
      Program() {
        skipFile = isReactAriaQuarantine(context.filename);
      },
      ImportDeclaration(node) {
        reportIfForbidden(node, specifierFromSource(node.source));
      },
      ExportNamedDeclaration(node) {
        reportIfForbidden(node, specifierFromSource(node.source));
      },
      ExportAllDeclaration(node) {
        reportIfForbidden(node, specifierFromSource(node.source));
      },
      ImportExpression(node) {
        reportIfForbidden(node, specifierFromSource(node.source));
      },
    };
  },
});
