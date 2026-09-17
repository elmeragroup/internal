import { defineRule } from "@oxlint/plugins";

import { normalizeFilename } from "../filename-normalizer.js";
import { isForbiddenRacSpecifier } from "../forbidden-rac-packages.js";

/** @import { ESTree } from "@oxlint/plugins" */

/**
 * The quarantine is exactly `packages/ui/src/react-aria/**`. Matching the full
 * package-relative segment keeps an unrelated `src/react-aria/` (another
 * package, another checkout) from counting as the quarantine.
 */
const QUARANTINE_DIR_RE = /(?:^|\/)packages\/ui\/src\/react-aria\//;

/**
 * @param {string} filename
 */
function isReactAriaQuarantine(filename) {
  return QUARANTINE_DIR_RE.test(normalizeFilename(filename));
}

/**
 * @param {ESTree.Node | null | undefined} source
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
        "Forbid react-aria-components, react-aria, @internationalized/date, and the scoped @react-aria/* / @react-stately/* packages outside packages/ui/src/react-aria/**",
    },
    messages: {
      quarantined: "`{{specifier}}` may only be imported from packages/ui/src/react-aria/** (quarantine).",
    },
    schema: [],
  },
  createOnce(context) {
    let skipFile = false;

    /**
     * @param {ESTree.Node} node
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
