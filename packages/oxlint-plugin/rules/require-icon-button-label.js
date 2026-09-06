import { defineRule } from "@oxlint/plugins";

const ICON_SIZE_PREFIX = "icon";
const TEXT_CONTENT_NAMES = new Set(["Span", "Text", "ItemTitle", "Title"]);

/**
 * Statically known string from a JSX attribute value or child expression.
 * Identifiers and interpolated templates stay unknown.
 *
 * @param {import("estree").Node | null | undefined} node
 * @returns {string | null}
 */
function getStaticString(node) {
  if (!node) return null;

  if (node.type === "Literal") {
    return typeof node.value === "string" ? node.value : null;
  }

  if (node.type === "TemplateLiteral") {
    if (node.expressions.length !== 0) return null;
    const cooked = node.quasis[0]?.value.cooked;
    return typeof cooked === "string" ? cooked : null;
  }

  if (node.type === "JSXExpressionContainer") {
    return getStaticString(node.expression);
  }

  return null;
}

/**
 * Known nonempty strings count. Known empty/whitespace, bare, null, and false do not.
 * Unresolved expressions stay permissive.
 *
 * @param {import("estree").JSXOpeningElement} node
 */
function hasUsableAriaLabel(node) {
  return node.attributes.some((attr) => {
    if (attr.type !== "JSXAttribute" || attr.name.name !== "aria-label") return false;
    if (!attr.value) return false;

    const staticString = getStaticString(attr.value);
    if (staticString !== null) return staticString.trim().length > 0;

    const expr = attr.value.type === "JSXExpressionContainer" ? attr.value.expression : attr.value;
    if (expr.type === "Literal") return false;

    return true;
  });
}

function hasSlot(node) {
  return node.attributes.some((attr) => attr.type === "JSXAttribute" && attr.name.name === "slot");
}

/**
 * Size/variant may also use an identifier's name as a heuristic (size={icon}).
 * That heuristic is not a known runtime string.
 *
 * @param {import("estree").JSXAttribute} attr
 * @returns {string | null}
 */
function getSizeOrVariantValue(attr) {
  const staticValue = getStaticString(attr.value);
  if (staticValue !== null) return staticValue;

  if (attr.value?.type === "JSXExpressionContainer" && attr.value.expression.type === "Identifier") {
    return attr.value.expression.name;
  }

  return null;
}

function isIconVariant(node) {
  return node.attributes.some((attr) => {
    if (attr.type !== "JSXAttribute" || attr.name.name !== "variant") return false;

    const value = getSizeOrVariantValue(attr);

    return value === "icon";
  });
}

function isIconSize(node) {
  return node.attributes.some((attr) => {
    if (attr.type !== "JSXAttribute" || attr.name.name !== "size") return false;

    const value = getSizeOrVariantValue(attr);
    if (!value) return false;

    return value.startsWith(ICON_SIZE_PREFIX);
  });
}

function getElementName(nameNode) {
  if (nameNode.type === "JSXIdentifier") {
    return nameNode.name;
  }

  if (nameNode.type === "JSXMemberExpression") {
    return nameNode.property.name;
  }

  return null;
}

function hasTextContent(node) {
  if (!node.children || node.children.length === 0) return false;

  return node.children.some((child) => {
    if (child.type === "JSXText") {
      return child.value.trim().length > 0;
    }

    if (child.type === "JSXExpressionContainer") {
      const expr = child.expression;
      if (expr.type === "CallExpression") return true;

      const staticString = getStaticString(expr);
      if (staticString !== null) return staticString.trim().length > 0;

      if (expr.type === "TemplateLiteral") return true;
    }

    if (child.type === "JSXElement") {
      const name = getElementName(child.openingElement.name);
      if (name && TEXT_CONTENT_NAMES.has(name)) return true;
      if (hasTextContent(child)) return true;
    }

    if (child.type === "JSXFragment") {
      return hasTextContent(child);
    }

    return false;
  });
}

export default defineRule({
  createOnce(context) {
    return {
      /** @param {import("estree").JSXOpeningElement} node */
      JSXOpeningElement(node) {
        const name = getElementName(node.name);

        if (name === null || !name.endsWith("Button")) return;

        if (!isIconVariant(node) && !isIconSize(node)) return;

        if (hasUsableAriaLabel(node)) return;

        if (hasSlot(node)) return;

        const parent = node.parent.type === "JSXElement" ? node.parent : null;

        if (parent && hasTextContent(parent)) return;

        context.report({
          loc: node.loc,
          messageId: "missingAriaLabel",
          data: { component: name },
        });
      },
    };
  },

  meta: {
    type: "problem",
    docs: {
      description:
        "Require a nonempty aria-label on icon-only *Button JSX (any name ending in Button, including InputGroup.Button) whose size starts with icon or variant is icon; static expression strings and templates count",
    },
    schema: [],
    messages: {
      missingAriaLabel:
        'Icon-only <{{component}}> must have an aria-label for accessibility. Add aria-label={t("...")} to provide a screen reader label.',
    },
  },
});
