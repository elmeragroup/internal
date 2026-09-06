// Adapted from kumo lint/no-primitive-colors.js (MIT, Copyright (c) 2026 Cloudflare, Inc.).
import { defineRule } from "@oxlint/plugins";

import { extractStrings, isNamedCall } from "../extract-strings.js";

const RULE_NAME = "no-primitive-colors";
const LITERAL_RULE = "color-literal";

// Allowed theme role tokens for library source.
const ROLE_TOKENS = new Set([
  "background",
  "foreground",
  "card",
  "card-foreground",
  "card-soft",
  "card-soft-foreground",
  "popover",
  "popover-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "feature",
  "feature-bright",
  "feature-foreground",
  "primary",
  "primary-foreground",
  "primary-soft",
  "primary-soft-foreground",
  "secondary",
  "secondary-foreground",
  "secondary-soft",
  "secondary-soft-foreground",
  "brand",
  "brand-foreground",
  "error",
  "error-foreground",
  "error-soft",
  "error-soft-foreground",
  "info",
  "info-foreground",
  "info-soft",
  "info-soft-foreground",
  "success",
  "success-foreground",
  "success-soft",
  "success-soft-foreground",
  "warning",
  "warning-foreground",
  "warning-soft",
  "warning-soft-foreground",
  "border",
  "input",
  "ring",
  "sidebar",
  "sidebar-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
  "sidebar-brand",
  "sidebar-brand-foreground",
  "right-panel",
  "right-panel-foreground",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "chart-6",
  "chart-7",
  "chart-8",
  "sh-identifier",
  "sh-keyword",
  "sh-string",
  "sh-class",
  "sh-property",
  "sh-entity",
  "sh-jsxliterals",
  "sh-sign",
  "sh-comment",
]);

const TAILWIND_COLOR_FAMILIES = new Set([
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "slate",
  "gray",
  "zinc",
  "neutral",
  "stone",
  "black",
  "white",
]);

const NON_COLOR_UTILITIES = new Set([
  "xs",
  "sm",
  "base",
  "lg",
  "xl",
  "2xl",
  "3xl",
  "4xl",
  "left",
  "center",
  "right",
  "justify",
  "wrap",
  "nowrap",
  "balance",
  "pretty",
  "ellipsis",
  "clip",
  "transparent",
  "current",
  "inherit",
  "none",
  "auto",
  "color",
  "0",
  "2",
  "4",
  "8",
  "t",
  "r",
  "b",
  "l",
  "x",
  "y",
  "solid",
  "dashed",
  "dotted",
  "double",
  "hidden",
  "collapse",
  "separate",
  "1",
  "inset",
  "inner",
]);

const NON_COLOR_PATTERNS = [
  /^linear-to-[trbl]{1,2}$/,
  /^[trblxy]-\d+$/,
  /^offset-\d+$/,
  /^\d+$/,
  /^clip-.+$/,
];

const TOKEN_RE =
  /(?:^|[^a-zA-Z0-9-])(((?:[a-z-]+:)*)?(?:bg|border|text|ring(?:-offset)?|fill|stroke|placeholder|caret|accent|decoration|divide|outline|from|via|to)-([a-z][a-z0-9-]*)(?:-\d{2,3})?(?:\/[0-9]{1,3})?)/gim;

const ARBITRARY_COLOR_RE =
  /\[(?:#[0-9a-fA-F]{3,8}(?:\/[\d.]+)?|(?:oklch|oklab|lab|lch|rgb|rgba|hsl|hsla|hwb)\()/i;

// Exceptions match complete class tokens.
const ALLOWED_EXACT_CLASSES = [
  "bg-black/10",
  "outline-black/10",
  "bg-[repeating-linear-gradient(45deg,transparent,transparent_8px,rgb(0_0_0/0.02)_8px,rgb(0_0_0/0.02)_16px)]",
];

/**
 * @param {string} tokenName
 */
function isNonColorUtility(tokenName) {
  if (NON_COLOR_UTILITIES.has(tokenName)) return true;
  return NON_COLOR_PATTERNS.some((pattern) => pattern.test(tokenName));
}

/**
 * @param {string} token
 */
function isAllowedExactClass(token) {
  return ALLOWED_EXACT_CLASSES.includes(token);
}

/**
 * Whole class tokens only. Variant prefixes are part of the
 * token, so `hover:bg-black/10` is not the documented `bg-black/10` literal.
 *
 * @param {string} str
 */
function stripAllowedClasses(str) {
  return str
    .split(/\s+/)
    .filter((token) => token.length > 0 && !isAllowedExactClass(token))
    .join(" ");
}

/**
 * @param {string} str
 */
function findPrimitiveColor(str) {
  TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = TOKEN_RE.exec(str))) {
    const fullToken = match[1];
    const colorFamily = match[3];
    if (!fullToken || !colorFamily) continue;

    const tokenName = colorFamily.replace(/\/\d+$/, "");
    if (isNonColorUtility(tokenName)) continue;
    if (ROLE_TOKENS.has(tokenName)) continue;

    const primitiveFamily = tokenName.replace(/-\d+$/, "");
    if (TAILWIND_COLOR_FAMILIES.has(primitiveFamily) || TAILWIND_COLOR_FAMILIES.has(tokenName)) {
      return fullToken;
    }
  }
  return null;
}

/**
 * @param {string} str
 */
function hasForbiddenColorLiteral(str) {
  return ARBITRARY_COLOR_RE.test(str);
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow raw palette classes and color literals; use role tokens",
    },
    messages: {
      [RULE_NAME]:
        "Avoid raw palette classes (e.g. `bg-white`, `text-slate-500`). Style with role tokens only.",
      [LITERAL_RULE]: "Avoid hex/oklch/rgb color literals in class strings. Style with role tokens only.",
    },
    schema: [],
  },
  defaultOptions: [],
  createOnce(context) {
    /**
     * @param {import("estree").Node} node
     * @param {string[]} collected
     */
    function reportColorIssues(node, collected) {
      for (const raw of collected) {
        const value = stripAllowedClasses(raw);
        if (findPrimitiveColor(value)) {
          context.report({ node, messageId: RULE_NAME });
          return;
        }
        if (hasForbiddenColorLiteral(value)) {
          context.report({ node, messageId: LITERAL_RULE });
          return;
        }
      }
    }

    return {
      JSXAttribute(node) {
        const name = node.name.type === "JSXIdentifier" ? node.name.name : undefined;
        if (name !== "className" && name !== "class") return;
        if (node.value) {
          reportColorIssues(node, extractStrings(node.value));
        }
      },
      CallExpression(node) {
        if (!isNamedCall(node.callee, "tv") && !isNamedCall(node.callee, "cn")) return;
        reportColorIssues(node, extractStrings(node));
      },
      Literal(node) {
        if (typeof node.value === "string") {
          reportColorIssues(node, [node.value]);
        }
      },
      TemplateLiteral(node) {
        reportColorIssues(node, extractStrings(node));
      },
    };
  },
});
