import { defineRule } from "@oxlint/plugins";

import { isNamedCall } from "../extract-strings.js";
import { isTestFile, normalizeFilename } from "../filename-normalizer.js";

const ALLOWED_SUFFIXES = ["/src/styles/utils.ts", "/src/react-aria/link/link.tsx"];

/**
 * @param {string} filename
 */
function isAllowedOwner(filename) {
  const normalized = normalizeFilename(filename);
  if (isTestFile(normalized)) {
    return true;
  }
  return ALLOWED_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid focusRing({…}) calls outside styles/utils.ts except the live isFocusVisible call in react-aria/link",
    },
    messages: {
      restrictedCall:
        "Fixed focus-ring rungs are the constants exported from styles/utils.ts. The only live `focusRing({…})` call is react-aria/link, which passes `isFocusVisible` per render.",
    },
    schema: [],
  },
  createOnce(context) {
    let skipFile = false;

    return {
      Program() {
        skipFile = isAllowedOwner(context.filename);
      },
      CallExpression(node) {
        if (skipFile || !isNamedCall(node.callee, "focusRing")) {
          return;
        }
        context.report({ node, messageId: "restrictedCall" });
      },
    };
  },
});
