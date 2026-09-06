import { defineRule } from "@oxlint/plugins";

const ICON_SIZE_PREFIX = "icon";
const TEXT_CONTENT_NAMES = new Set(["Span", "Text", "ItemTitle", "Title"]);

function hasAriaLabel(node) {
  return node.attributes.some((attr) => attr.type === "JSXAttribute" && attr.name.name === "aria-label");
}

function hasSlot(node) {
  return node.attributes.some((attr) => attr.type === "JSXAttribute" && attr.name.name === "slot");
}

function getStringAttrValue(attr) {
  if (!attr.value) return null;

  if (attr.value.type === "Literal") {
    return typeof attr.value.value === "string" ? attr.value.value : null;
  }

  if (attr.value.type === "JSXExpressionContainer" && attr.value.expression.type === "Identifier") {
    return attr.value.expression.name;
  }

  return null;
}

function isIconVariant(node) {
  return node.attributes.some((attr) => {
    if (attr.type !== "JSXAttribute" || attr.name.name !== "variant") return false;

    const value = getStringAttrValue(attr);

    return value === "icon";
  });
}

function isIconSize(node) {
  return node.attributes.some((attr) => {
    if (attr.type !== "JSXAttribute" || attr.name.name !== "size") return false;

    const value = getStringAttrValue(attr);
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
      if (expr.type === "Literal" && typeof expr.value === "string") return true;
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

        if (hasAriaLabel(node)) return;

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
        "Require aria-label on icon-only *Button JSX (any name ending in Button, including InputGroup.Button) whose size starts with icon",
    },
    schema: [],
    messages: {
      missingAriaLabel:
        'Icon-only <{{component}}> must have an aria-label for accessibility. Add aria-label={t("...")} to provide a screen reader label.',
    },
  },
});
