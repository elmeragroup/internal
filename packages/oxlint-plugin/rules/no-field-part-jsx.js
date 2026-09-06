import { defineRule } from "@oxlint/plugins";

import { normalizeFilename } from "../filename-normalizer.js";

const BANNED_PARTS = new Set(["Label", "Description", "Error", "Root", "Set", "Legend"]);

const LABELED_COMPOSITES = [
  "/src/components/text-field/text-field.tsx",
  "/src/components/number-field/number-field.tsx",
  "/src/components/textarea-field/textarea-field.tsx",
  "/src/components/phone-number-field/phone-number-field.tsx",
  "/src/components/checkbox/checkbox.tsx",
  "/src/components/radio-group/radio-group.tsx",
];

/**
 * @param {string} filename
 */
function isLabeledComposite(filename) {
  const normalized = normalizeFilename(filename);
  return LABELED_COMPOSITES.some((suffix) => normalized.endsWith(suffix));
}

/**
 * @param {import("estree").Node | null | undefined} nameNode
 * @returns {string | null}
 */
function fieldPartName(nameNode) {
  if (nameNode?.type !== "JSXMemberExpression") {
    return null;
  }
  const object = nameNode.object;
  const property = nameNode.property;
  if (object?.type !== "JSXIdentifier" || object.name !== "Field") {
    return null;
  }
  if (property?.type !== "JSXIdentifier") {
    return null;
  }
  return property.name;
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid Field.Label/Description/Error/Root/Set/Legend JSX in labeled composites that must go through FieldFrame",
    },
    messages: {
      fieldPart:
        "Labeled composites render <Field.{{part}}> through FieldFrame. Do not reopen that markup here.",
    },
    schema: [],
  },
  defaultOptions: [],
  createOnce(context) {
    let skipFile = true;

    return {
      Program() {
        skipFile = !isLabeledComposite(context.filename);
      },
      JSXOpeningElement(node) {
        if (skipFile) {
          return;
        }
        const part = fieldPartName(node.name);
        if (part === null || !BANNED_PARTS.has(part)) {
          return;
        }
        context.report({ node, messageId: "fieldPart", data: { part } });
      },
    };
  },
});
