// Lifted from kumo lint/no-tailwind-dark-variant.js (MIT, Copyright (c) 2026 Cloudflare, Inc.).
import { defineRule } from "@oxlint/plugins";

import { extractStrings } from "../extract-strings.js";

const RULE_NAME = "no-tailwind-dark-variant";

/**
 * Tailwind names the built-in dark axis `dark`; `not-dark` is its compound negation. Other
 * `-dark` segments are named or custom variants (`data-dark:`, `theme-dark:`) and stay valid.
 * @param {string} segment
 */
function isDarkSegment(segment) {
  return segment === "dark" || segment === "not-dark";
}

/**
 * @param {string} token
 */
function tokenHasDarkVariant(token) {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i += 1) {
    const ch = token[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "[" || ch === "(") {
      depth += 1;
    } else if ((ch === "]" || ch === ")") && depth > 0) {
      depth -= 1;
    } else if (ch === ":" && depth === 0) {
      const segment = token.slice(start, i);
      if (isDarkSegment(segment) && i + 1 < token.length) {
        return true;
      }
      start = i + 1;
    }
  }
  return false;
}

/**
 * @param {string} str
 */
function hasDarkVariant(str) {
  return str.split(/\s+/).some((token) => token !== "" && tokenHasDarkVariant(token));
}

/**
 * @param {import("estree").Node} node
 */
function isInsideJsxAttribute(node) {
  let current = node.parent;
  while (current) {
    if (current.type === "JSXAttribute") return true;
    current = current.parent;
  }
  return false;
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow Tailwind dark: variant usage in library source",
    },
    messages: {
      [RULE_NAME]:
        'Avoid Tailwind\'s dark: variant. The dark axis is token-reserved behind [data-theme="dark"].',
    },
    schema: [],
  },
  defaultOptions: [],
  createOnce(context) {
    /**
     * @param {import("estree").Node} node
     * @param {string[]} collected
     */
    function reportIfDark(node, collected) {
      for (const s of collected) {
        if (hasDarkVariant(s)) {
          context.report({ node, messageId: RULE_NAME });
          return;
        }
      }
    }

    return {
      JSXAttribute(node) {
        const name = node.name.type === "JSXIdentifier" ? node.name.name : undefined;
        if (name !== "className" && name !== "class") return;

        if (node.value) {
          reportIfDark(node, extractStrings(node.value));
        }
      },
      Literal(node) {
        if (typeof node.value !== "string" || !hasDarkVariant(node.value) || isInsideJsxAttribute(node)) {
          return;
        }

        context.report({ node, messageId: RULE_NAME });
      },
      TemplateLiteral(node) {
        if (isInsideJsxAttribute(node)) {
          return;
        }

        const strings = extractStrings(node);
        if (strings.some(hasDarkVariant)) {
          context.report({ node, messageId: RULE_NAME });
        }
      },
    };
  },
});
