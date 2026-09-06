import { defineRule } from "@oxlint/plugins";

import { extractStrings, isNamedCall } from "../extract-strings.js";

const CONTROL_VAR_RE = /--control-(?:h|px-icon|px|gap)-|--control-(?:text|leading)\b/;

const KEYWORD_BOX = new Set([
  "auto",
  "full",
  "min",
  "max",
  "fit",
  "screen",
  "svh",
  "lvh",
  "dvh",
  "svw",
  "lvw",
  "dvw",
  "px",
  "lh",
  "none",
  "svmin",
  "lvmin",
  "dvmin",
  "svmax",
  "lvmax",
  "dvmax",
]);

const ICON_GLYPH_SIZES = new Set(["3", "4"]);

const TYPE_SCALE = new Set([
  "xs",
  "sm",
  "base",
  "lg",
  "xl",
  "2xl",
  "3xl",
  "4xl",
  "5xl",
  "6xl",
  "7xl",
  "8xl",
  "9xl",
]);

const MD_LG_KEYS = new Set(["md", "lg", "default"]);

const BUTTON_SIZE_KEYS = new Set([
  "default",
  "xs",
  "sm",
  "md",
  "lg",
  "icon",
  "icon-xxs",
  "icon-xs",
  "icon-sm",
  "icon-inline",
  "icon-lg",
]);

/**
 * @param {import("estree").ObjectExpression} obj
 * @param {string} name
 * @returns {import("estree").Node | null}
 */
function objectPropValue(obj, name) {
  for (const prop of obj.properties) {
    if (prop.type !== "Property") continue;
    const keyName =
      prop.key.type === "Identifier" ? prop.key.name : prop.key.type === "Literal" ? prop.key.value : null;
    if (keyName === name) return prop.value;
  }
  return null;
}

/**
 * @param {import("estree").Property} prop
 * @returns {string | null}
 */
function propertyName(prop) {
  if (prop.computed && prop.key.type !== "Literal") return null;
  if (prop.key.type === "Identifier") return prop.key.name;
  if (prop.key.type === "Literal" && typeof prop.key.value === "string") return prop.key.value;
  return null;
}

/**
 * @param {string} str
 * @param {number} start
 */
function matchingBracket(str, start) {
  if (str[start] !== "[") return -1;
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Strip Tailwind variant prefixes, including arbitrary and data variants.
 * @param {string} className
 */
function stripVariantPrefixes(className) {
  let rest = className;
  while (rest.length > 0) {
    if (rest.startsWith("[")) {
      const end = matchingBracket(rest, 0);
      if (end !== -1 && rest[end + 1] === ":") {
        rest = rest.slice(end + 2);
        continue;
      }
      break;
    }
    if (rest.startsWith("*:") || rest.startsWith("**:")) {
      rest = rest.slice(rest.indexOf(":") + 1);
      continue;
    }
    const nameMatch = /^[a-zA-Z@][\w-]*(?:\/[\w-]+)?/.exec(rest);
    if (!nameMatch) break;
    let i = nameMatch[0].length;
    if (rest[i] === "[") {
      const end = matchingBracket(rest, i);
      if (end === -1) break;
      i = end + 1;
    }
    if (rest[i] === ":") {
      rest = rest.slice(i + 1);
      continue;
    }
    break;
  }
  return rest;
}

/**
 * @param {string} className
 */
function isDescendantTargeted(className) {
  return /\[[^\]]*&/.test(className);
}

/**
 * @param {string} utility
 */
function stripImportant(utility) {
  let next = utility;
  if (next.startsWith("!")) next = next.slice(1);
  if (next.endsWith("!")) next = next.slice(0, -1);
  return next;
}

/**
 * @param {string} utility
 */
function readsDensityVariable(utility) {
  return CONTROL_VAR_RE.test(utility);
}

/**
 * @param {string} sizeKey
 */
function isMdLgRung(sizeKey) {
  return MD_LG_KEYS.has(sizeKey);
}

/**
 * @param {string} value
 */
function isKeywordBox(value) {
  return KEYWORD_BOX.has(value);
}

/**
 * @param {string} utility
 * @param {string} prefix
 * @returns {string | null}
 */
function valueAfter(utility, prefix) {
  if (!utility.startsWith(prefix)) return null;
  return utility.slice(prefix.length);
}

/**
 * @param {string} utility
 * @returns {string | null}
 */
function boxFamily(utility) {
  const height = valueAfter(utility, "h-");
  if (height !== null) {
    if (!height || isKeywordBox(height)) return null;
    return "height";
  }

  const square = valueAfter(utility, "size-");
  if (square !== null) {
    if (!square || isKeywordBox(square) || ICON_GLYPH_SIZES.has(square)) return null;
    return "height";
  }

  const gapX = valueAfter(utility, "gap-x-");
  if (gapX !== null) return gapX && !isKeywordBox(gapX) ? "gap" : null;

  const gapY = valueAfter(utility, "gap-y-");
  if (gapY !== null) return null;

  const gap = valueAfter(utility, "gap-");
  if (gap !== null) return gap && !isKeywordBox(gap) ? "gap" : null;

  const px = valueAfter(utility, "px-");
  if (px !== null) return px && !isKeywordBox(px) ? "inline padding" : null;

  const pl = valueAfter(utility, "pl-");
  if (pl !== null) return pl && !isKeywordBox(pl) ? "icon-edge padding" : null;

  const pr = valueAfter(utility, "pr-");
  if (pr !== null) return pr && !isKeywordBox(pr) ? "icon-edge padding" : null;

  const ps = valueAfter(utility, "ps-");
  if (ps !== null) return ps && !isKeywordBox(ps) ? "icon-edge padding" : null;

  const pe = valueAfter(utility, "pe-");
  if (pe !== null) return pe && !isKeywordBox(pe) ? "icon-edge padding" : null;

  return null;
}

/**
 * @param {string} utility
 * @returns {string | null}
 */
function typeFamily(utility) {
  if (utility.startsWith("[font-size:") || utility.startsWith("[line-height:")) {
    return "type";
  }
  if (utility.startsWith("leading-")) return "type";
  const text = valueAfter(utility, "text-");
  if (text === null) return null;
  const scale = text.split("/")[0];
  if (scale && (TYPE_SCALE.has(scale) || scale.startsWith("[") || scale.startsWith("("))) {
    return "type";
  }
  return null;
}

/**
 * @param {string} className
 */
function isControlBoxHeightClass(className) {
  if (isDescendantTargeted(className)) return false;
  const utility = stripImportant(stripVariantPrefixes(className));
  if (!utility) return false;
  if (utility.includes("--control-h-")) return true;
  const height = valueAfter(utility, "h-");
  if (height !== null) return Boolean(height) && !isKeywordBox(height);
  const square = valueAfter(utility, "size-");
  if (square === null) return false;
  if (ICON_GLYPH_SIZES.has(square) || isKeywordBox(square)) return false;
  return Boolean(square);
}

/**
 * @param {string} utility
 */
function isOpticalArbitrary(utility) {
  return /^(?:h|w|size|min-h|min-w|px|pl|pr|ps|pe|gap(?:-[xy])?)-\[\d+(?:\.\d+)?px\]$/.test(utility);
}

/**
 * @param {string} className
 */
function isDataSizeToken(className) {
  return /(?:^|:)data-\[size=/.test(className) && !className.includes("has-data-[size=");
}

/**
 * @param {string} className
 * @param {boolean} checkType
 * @returns {string | null}
 */
function densityOwnedFamily(className, checkType) {
  if (isDescendantTargeted(className)) return null;
  const utility = stripImportant(stripVariantPrefixes(className));
  if (!utility) return null;
  if (readsDensityVariable(utility)) return null;
  // Token reads (any custom property) and arbitrary values are not the numeric ladder.
  if (/\(--[\w-]+\)/.test(utility) || /var\(--/.test(utility)) return null;
  if (/^(?:h|w|size|min-h|min-w|px|pl|pr|ps|pe|gap(?:-[xy])?)-\[/.test(utility)) return null;
  if (isOpticalArbitrary(utility)) return null;
  const box = boxFamily(utility);
  if (box) return box;
  if (!checkType) return null;
  return typeFamily(utility);
}

/**
 * @param {string} str
 * @returns {string[]}
 */
function classTokens(str) {
  return str.split(/\s+/).filter(Boolean);
}

/**
 * Class tokens from a tv/cn/record arm, excluding `data-[size=…]` tokens
 * which are reported from the literal/template visitors instead.
 *
 * @param {import("estree").Node | null | undefined} node
 * @returns {string[]}
 */
function recipeTokens(node) {
  return extractStrings(node)
    .flatMap(classTokens)
    .filter((token) => !isDataSizeToken(token));
}

/**
 * @param {import("estree").Node | null | undefined} node
 * @param {string} name
 */
function isInsideNamedCall(node, name) {
  for (let current = node?.parent; current; current = current.parent) {
    if (current.type === "CallExpression" && isNamedCall(current.callee, name)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string[]} tokens
 */
function tokensHaveControlHeightPin(tokens) {
  return tokens.some((token) => token.includes("--control-h-"));
}

/**
 * @param {string[]} tokens
 */
function tokensHaveControlVar(tokens) {
  return tokens.some((token) => CONTROL_VAR_RE.test(token));
}

/**
 * @param {string[]} tokens
 */
function checkTypeForTokens(tokens) {
  return tokens.some((token) => /--control-h-(?:md|lg)\b/.test(token) || /--control-text\b/.test(token));
}

/**
 * @param {import("estree").ObjectExpression} obj
 * @returns {Array<{ key: string; value: import("estree").Node }> | null}
 */
function recordArms(obj) {
  /** @type {Array<{ key: string; value: import("estree").Node }>} */
  const arms = [];
  for (const prop of obj.properties) {
    if (prop.type !== "Property") return null;
    const key = propertyName(prop);
    if (key === null) return null;
    arms.push({ key, value: prop.value });
  }
  return arms;
}

/**
 * @param {import("estree").ObjectExpression} obj
 */
function isButtonSizeKeyedRecord(obj) {
  const arms = recordArms(obj);
  if (arms === null || arms.length === 0) return false;
  return arms.every((arm) => BUTTON_SIZE_KEYS.has(arm.key));
}

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Warn when control-box recipes, data-[size] class strings, cn() strings, tv slots, or Button-size-keyed records hardcode density-owned metrics instead of reading --control-* variables",
    },
    messages: {
      hardcodedMetric:
        "Hardcoded density-owned {{family}} `{{utility}}`. Read the matching `--control-*` variable instead.",
    },
    schema: [],
  },
  defaultOptions: [],
  createOnce(context) {
    let fileHasControlH = false;

    /**
     * @param {import("estree").Node} node
     * @param {string[]} tokens
     * @param {boolean} checkType
     */
    function reportTokens(node, tokens, checkType) {
      for (const token of tokens) {
        const family = densityOwnedFamily(token, checkType);
        if (!family) continue;
        context.report({
          node,
          messageId: "hardcodedMetric",
          data: { family, utility: token },
        });
      }
    }

    /**
     * @param {import("estree").Node} node
     * @param {string} value
     */
    function reportDataSizeLiterals(node, value) {
      reportTokens(node, classTokens(value).filter(isDataSizeToken), false);
    }

    /**
     * @param {import("estree").CallExpression} node
     */
    function reportCnLiterals(node) {
      if (isInsideNamedCall(node, "tv")) return;
      const tokens = recipeTokens(node);
      if (!fileHasControlH && !tokensHaveControlHeightPin(tokens)) return;
      reportTokens(node, tokens, checkTypeForTokens(tokens));
    }

    /**
     * @param {import("estree").ObjectExpression} recipe
     */
    function reportTvSlots(recipe) {
      const slots = objectPropValue(recipe, "slots");
      if (slots?.type !== "ObjectExpression") return;
      for (const prop of slots.properties) {
        if (prop.type !== "Property") continue;
        const tokens = recipeTokens(prop.value);
        if (!fileHasControlH && !tokensHaveControlHeightPin(tokens) && !tokensHaveControlVar(tokens)) {
          continue;
        }
        reportTokens(prop.value, tokens, checkTypeForTokens(tokens));
      }
    }

    /**
     * @param {import("estree").ObjectExpression} node
     */
    function reportSizeKeyedRecord(node) {
      if (isInsideNamedCall(node, "tv")) return;
      if (!isButtonSizeKeyedRecord(node)) return;
      const arms = recordArms(node);
      if (arms === null) return;
      const groups = arms.map((arm) => ({
        key: arm.key,
        node: arm.value,
        tokens: recipeTokens(arm.value),
      }));
      const allTokens = groups.flatMap((group) => group.tokens);
      if (
        !fileHasControlH &&
        !tokensHaveControlHeightPin(allTokens) &&
        !allTokens.some(isControlBoxHeightClass)
      ) {
        return;
      }
      for (const group of groups) {
        reportTokens(group.node, group.tokens, isMdLgRung(group.key));
      }
    }

    return {
      Program() {
        fileHasControlH = context.sourceCode.getText().includes("--control-h-");
      },
      Literal(node) {
        if (typeof node.value === "string") {
          reportDataSizeLiterals(node, node.value);
        }
      },
      TemplateLiteral(node) {
        for (const quasi of node.quasis) {
          if (typeof quasi.value.cooked === "string") {
            reportDataSizeLiterals(quasi, quasi.value.cooked);
          }
        }
      },
      ObjectExpression(node) {
        reportSizeKeyedRecord(node);
      },
      CallExpression(node) {
        if (isNamedCall(node.callee, "cn")) {
          reportCnLiterals(node);
          return;
        }
        if (!isNamedCall(node.callee, "tv")) return;
        if (node.arguments.length === 0) return;
        const recipe = node.arguments[0];
        if (recipe.type !== "ObjectExpression") return;
        const variants = objectPropValue(recipe, "variants");
        const size = variants?.type === "ObjectExpression" ? objectPropValue(variants, "size") : null;

        if (size?.type === "ObjectExpression") {
          for (const prop of size.properties) {
            if (prop.type !== "Property") continue;
            const sizeKey = propertyName(prop);
            if (sizeKey === null) continue;
            const tokens = recipeTokens(prop.value);
            const isControlBox = tokens.some(isControlBoxHeightClass);
            // Decorative/layout size axes (no pinned control height) are not density rungs.
            if (!isControlBox) continue;
            const checkType = isMdLgRung(sizeKey);
            reportTokens(prop.value, tokens, checkType);
          }
        } else {
          // No size axis: a control-box recipe may still pin its height in base or
          // on a `box` axis (field-box's control/content height model). Decorative
          // variant axes (e.g. media image sizes) are not density rungs, so only
          // base and the `box` axis are scanned.
          /** @type {Array<{ node: import("estree").Node; tokens: string[] }>} */
          const groups = [];
          const base = objectPropValue(recipe, "base");
          if (base) {
            groups.push({
              node: base,
              tokens: recipeTokens(base),
            });
          }
          const box = variants?.type === "ObjectExpression" ? objectPropValue(variants, "box") : null;
          if (box?.type === "ObjectExpression") {
            for (const arm of box.properties) {
              if (arm.type !== "Property") continue;
              groups.push({
                node: arm.value,
                tokens: recipeTokens(arm.value),
              });
            }
          }
          if (groups.some((group) => group.tokens.some(isControlBoxHeightClass))) {
            for (const group of groups) {
              reportTokens(group.node, group.tokens, false);
            }
          }
        }

        reportTvSlots(recipe);
      },
    };
  },
});
