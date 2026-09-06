import { defineRule } from "@oxlint/plugins";

import { extractStrings } from "../extract-strings.js";
import { normalizeFilename } from "../filename-normalizer.js";

/**
 * Exact utilities that are legal class tokens without a hyphenated suffix.
 * `z-*` is omitted on purpose: `overlayLayer = "z-50"` is the one-owner keep.
 */
const EXACT_UTILITIES = new Set([
  "flex",
  "grid",
  "block",
  "inline",
  "inline-block",
  "inline-flex",
  "inline-grid",
  "inline-table",
  "contents",
  "hidden",
  "visible",
  "invisible",
  "collapse",
  "isolate",
  "relative",
  "absolute",
  "sticky",
  "fixed",
  "static",
  "grow",
  "shrink",
  "truncate",
  "underline",
  "overline",
  "line-through",
  "no-underline",
  "italic",
  "not-italic",
  "uppercase",
  "lowercase",
  "capitalize",
  "normal-case",
  "border",
  "rounded",
  "shadow",
  "ring",
  "outline",
  "blur",
  "group",
  "peer",
  "container",
  "table",
  "table-cell",
  "table-row",
  "table-column",
  "list-item",
  "flow-root",
  "antialiased",
  "subpixel-antialiased",
  "sr-only",
  "not-sr-only",
  "tabular-nums",
  "select-none",
  "select-text",
  "select-all",
  "select-auto",
  "pointer-events-none",
  "pointer-events-auto",
  "appearance-none",
  "resize",
  "resize-none",
  "resize-x",
  "resize-y",
  "not-prose",
  "prose",
]);

/**
 * Hyphenated (or bracket/paren) Tailwind prefixes. Single-letter prefixes keep the
 * hyphen so `p-` does not match `px-`/`previous`.
 */
const UTILITY_PREFIXES = [
  "text-",
  "bg-",
  "border-",
  "flex-",
  "grid-",
  "gap-",
  "p-",
  "px-",
  "py-",
  "pt-",
  "pr-",
  "pb-",
  "pl-",
  "ps-",
  "pe-",
  "m-",
  "mx-",
  "my-",
  "mt-",
  "mr-",
  "mb-",
  "ml-",
  "ms-",
  "me-",
  "size-",
  "h-",
  "w-",
  "min-h-",
  "min-w-",
  "max-h-",
  "max-w-",
  "rounded-",
  "font-",
  "items-",
  "justify-",
  "self-",
  "content-",
  "place-",
  "shadow-",
  "ring-",
  "outline-",
  "opacity-",
  "scale-",
  "blur-",
  "rotate-",
  "translate-",
  "skew-",
  "origin-",
  "duration-",
  "ease-",
  "delay-",
  "transition-",
  "animate-",
  "slide-",
  "fade-",
  "zoom-",
  "spin-",
  "cursor-",
  "pointer-events-",
  "select-",
  "overflow-",
  "overscroll-",
  "whitespace-",
  "break-",
  "leading-",
  "tracking-",
  "indent-",
  "align-",
  "list-",
  "decoration-",
  "underline-offset-",
  "line-clamp-",
  "from-",
  "via-",
  "to-",
  "divide-",
  "space-",
  "basis-",
  "grow-",
  "shrink-",
  "col-",
  "row-",
  "order-",
  "inset-",
  "top-",
  "right-",
  "bottom-",
  "left-",
  "start-",
  "end-",
  "object-",
  "aspect-",
  "fill-",
  "stroke-",
  "accent-",
  "caret-",
  "scroll-",
  "snap-",
  "touch-",
  "will-change-",
  "backdrop-",
  "drop-shadow-",
  "brightness-",
  "contrast-",
  "saturate-",
  "hue-rotate-",
  "grayscale-",
  "invert-",
  "sepia-",
  "mix-blend-",
  "filter-",
  "transform-",
  "caption-",
  "hyphens-",
  "columns-",
  "float-",
  "clear-",
  "box-",
  "isolation-",
  "hit-area-",
  "auto-rows-",
  "auto-cols-",
  "@container",
];

/**
 * @param {string} filename
 */
function isTestFile(filename) {
  return (
    filename.endsWith(".test.ts") ||
    filename.endsWith(".test.tsx") ||
    filename.endsWith(".browser.test.tsx") ||
    filename.endsWith(".test-d.tsx")
  );
}

/**
 * @param {string} filename
 */
function isSkippedPath(filename) {
  const normalized = normalizeFilename(filename);
  if (isTestFile(normalized)) return true;
  if (normalized.includes("/intl/")) return true;
  if (normalized.includes("/generated/")) return true;
  return false;
}

/**
 * @param {import("estree").Node | null | undefined} node
 */
function unwrap(node) {
  let current = node;
  while (current) {
    if (
      current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSTypeAssertion" ||
      current.type === "ParenthesizedExpression" ||
      current.type === "ChainExpression"
    ) {
      current = current.expression;
      continue;
    }
    break;
  }
  return current;
}

/**
 * @param {string} str
 */
function classTokens(str) {
  return str.split(/\s+/).filter(Boolean);
}

/**
 * Last `:` outside brackets, then strip important/negative modifiers.
 * @param {string} token
 */
function utilityOf(token) {
  let depth = 0;
  let lastColon = -1;
  for (let i = 0; i < token.length; i += 1) {
    const ch = token[i];
    if (ch === "[") depth += 1;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === ":" && depth === 0) lastColon = i;
  }
  let utility = lastColon === -1 ? token : token.slice(lastColon + 1);
  if (utility.startsWith("!")) utility = utility.slice(1);
  if (utility.endsWith("!")) utility = utility.slice(0, -1);
  if (utility.startsWith("-") && utility.length > 1 && /[a-z@]/i.test(utility[1])) {
    utility = utility.slice(1);
  }
  return utility;
}

/**
 * @param {string} token
 */
function isArbitraryProperty(token) {
  return token.startsWith("[") && token.endsWith("]") && (token.startsWith("[--") || token.includes(":"));
}

/**
 * @param {string} token
 */
function isPrefixedOrArbitraryUtility(token) {
  if (!token) return false;
  if (isArbitraryProperty(token)) return true;
  if (token.startsWith("group/") || token.startsWith("peer/")) return true;
  return UTILITY_PREFIXES.some((prefix) => token.startsWith(prefix));
}

/**
 * @param {string} token
 */
function isTailwindUtility(token) {
  if (!token) return false;
  if (isPrefixedOrArbitraryUtility(token)) return true;
  return EXACT_UTILITIES.has(token);
}

/**
 * @param {string} raw
 */
function isTailwindToken(raw) {
  return isTailwindUtility(utilityOf(raw));
}

/**
 * A string looks like a class list when it has a hyphenated/arbitrary utility, or when
 * every token is a utility (`"flex isolate"`). Exact-only hits such as the English word
 * `block` in a comment are not enough.
 *
 * @param {string} str
 */
function looksLikeClassString(str) {
  const tokens = classTokens(str);
  if (tokens.length === 0) return false;
  const hits = tokens.filter(isTailwindToken);
  if (hits.length === 0) return false;
  if (hits.some((token) => isPrefixedOrArbitraryUtility(utilityOf(token)))) return true;
  return hits.length === tokens.length;
}

/**
 * @param {string} name
 */
function looksLikeClassIdentifier(name) {
  return /(?:Class(?:es|Name)?|classNames)$/.test(name);
}

/**
 * @param {import("estree").Node | null | undefined} node
 * @param {string[]} out
 */
function collectValueStrings(node, out) {
  const current = unwrap(node);
  if (!current) return;
  switch (current.type) {
    case "Literal": {
      if (typeof current.value === "string") out.push(current.value);
      break;
    }
    case "TemplateLiteral": {
      out.push(...extractStrings(current));
      break;
    }
    case "ObjectExpression": {
      for (const prop of current.properties) {
        if (prop.type === "Property") collectValueStrings(prop.value, out);
      }
      break;
    }
    case "ArrayExpression": {
      for (const el of current.elements) {
        if (el) collectValueStrings(el, out);
      }
      break;
    }
    default:
      break;
  }
}

/**
 * @param {import("estree").ObjectExpression} node
 */
function objectLooksLikeClassMap(node) {
  /** @type {string[]} */
  const values = [];
  collectValueStrings(node, values);
  return values.some(looksLikeClassString);
}

/**
 * @param {import("estree").TemplateLiteral} node
 */
function templateLooksLikeClassString(node) {
  const staticText = node.quasis.map((quasi) => quasi.value.cooked ?? "").join(" ");
  if (looksLikeClassString(staticText)) return true;
  if (node.expressions.length === 0) return false;
  const allIdents = node.expressions.every((expr) => expr.type === "Identifier");
  if (!allIdents) return false;
  return node.expressions.some((expr) => expr.type === "Identifier" && looksLikeClassIdentifier(expr.name));
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid raw Tailwind class maps and hand-spelled class constants. Maps with an axis or two-plus slots are tv() recipes; a single axis-less string is cn(). Any call-expression initializer is accepted. EXACT_UTILITIES and UTILITY_PREFIXES are the heuristic boundary for 'looks like Tailwind'. Skips tests, *.test-d.tsx, intl dictionaries, and generated files",
    },
    messages: {
      rawClassMap:
        'Class maps with an axis or two or more slots are `tv()` recipes; a single axis-less class string is `cn("…")`. Resolved string constants are legal when they are `cn(…)` or a recipe call, never spelled by hand.',
    },
    schema: [],
  },
  defaultOptions: [],
  createOnce(context) {
    let skipFile = false;

    /**
     * @param {import("estree").Node} node
     */
    function report(node) {
      context.report({ node, messageId: "rawClassMap" });
    }

    return {
      Program() {
        skipFile = isSkippedPath(context.filename);
      },
      VariableDeclarator(node) {
        if (skipFile || !node.init) return;

        const init = unwrap(node.init);
        if (!init) return;
        if (init.type === "CallExpression") return;

        if (init.type === "ObjectExpression") {
          if (objectLooksLikeClassMap(init)) report(init);
          return;
        }

        if (init.type === "Literal" && typeof init.value === "string") {
          if (looksLikeClassString(init.value)) report(init);
          return;
        }

        if (init.type === "TemplateLiteral" && templateLooksLikeClassString(init)) {
          report(init);
        }
      },
    };
  },
});
