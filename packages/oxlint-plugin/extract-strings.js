/**
 * Collect string literals from an ESTree node (class names, tv/cn args).
 * Lifted from kumo lint helpers (MIT, Copyright (c) 2026 Cloudflare, Inc.).
 *
 * @param {import("estree").Node | null | undefined} node
 * @returns {string[]}
 */
export function extractStrings(node) {
  if (!node) return [];
  const out = [];

  switch (node.type) {
    case "Literal": {
      if (typeof node.value === "string") out.push(node.value);
      break;
    }
    case "TemplateLiteral": {
      for (const q of node.quasis) {
        if (typeof q.value.cooked === "string") out.push(q.value.cooked);
      }
      break;
    }
    case "BinaryExpression": {
      if (node.operator === "+") {
        out.push(...extractStrings(node.left));
        out.push(...extractStrings(node.right));
      }
      break;
    }
    case "ArrayExpression": {
      for (const el of node.elements) {
        if (el) {
          out.push(...extractStrings(el));
        }
      }
      break;
    }
    case "ObjectExpression": {
      for (const prop of node.properties) {
        if (prop.type === "Property") {
          out.push(...extractStrings(prop.key));
          out.push(...extractStrings(prop.value));
        }
      }
      break;
    }
    case "CallExpression": {
      for (const arg of node.arguments) {
        if (arg.type === "SpreadElement") continue;
        out.push(...extractStrings(arg));
      }
      break;
    }
    case "ConditionalExpression": {
      out.push(...extractStrings(node.consequent));
      out.push(...extractStrings(node.alternate));
      out.push(...extractStrings(node.test));
      break;
    }
    case "UnaryExpression": {
      out.push(...extractStrings(node.argument));
      break;
    }
    case "LogicalExpression": {
      out.push(...extractStrings(node.left));
      out.push(...extractStrings(node.right));
      break;
    }
    case "JSXText": {
      out.push(node.value);
      break;
    }
    case "JSXExpressionContainer": {
      out.push(...extractStrings(node.expression));
      break;
    }
  }

  return out;
}

/**
 * @param {import("estree").Node | null | undefined} callee
 * @param {string} name
 */
export function isNamedCall(callee, name) {
  return callee?.type === "Identifier" && callee.name === name;
}
