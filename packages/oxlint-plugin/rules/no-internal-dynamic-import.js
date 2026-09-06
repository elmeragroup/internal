import { defineRule } from "@oxlint/plugins";

export default defineRule({
  createOnce(context) {
    return {
      /** @param {import("estree").ImportExpression} node */
      ImportExpression(node) {
        context.report({
          loc: node.loc,
          messageId: "noDynamicImport",
        });
      },
    };
  },

  meta: {
    type: "problem",
    docs: {
      description: "Disallow dynamic import() in library source; apps own code splitting",
    },
    schema: [],
    messages: {
      noDynamicImport:
        "The library never lazy-loads internally. Dynamic import() is forbidden in packages/ui/src.",
    },
  },
});
