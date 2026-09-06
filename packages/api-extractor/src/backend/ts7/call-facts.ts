import type { CallExpression, Node } from "typescript/unstable/ast";
import { isElementAccessExpression, isStringLiteral } from "typescript/unstable/ast/is";

import { definedFields } from "../../optional-fields.ts";
import type { BackendNodeFacts, BackendSymbolHandle, BackendSymbolOrigin } from "../contracts.ts";
import type { TsgoFactsSession } from "./facts.ts";
import { moduleOriginResolutionOfExpression } from "./module-origin.ts";

/**
 * Normalizes the generic relation exposed by a call expression. The parser
 * decides which callees have meaningful wrapper semantics; this adapter only
 * reports the syntax node and the checker symbol behind it.
 */
export function callExpressionFacts(
  session: TsgoFactsSession,
  node: CallExpression,
  originOf: (symbol: BackendSymbolHandle) => BackendSymbolOrigin
): Pick<BackendNodeFacts, "arguments" | "callee" | "calleeFacts"> {
  const calleeSymbol = calleeSymbolAt(session, node.expression);
  const result = {
    arguments: node.arguments.map((argument) => session.nodeHandle(argument)),
    callee: session.nodeHandle(node.expression),
  };
  if (calleeSymbol === undefined) return result;
  const origin = originOf(calleeSymbol);
  // Expression syntax can recover a namespace root that the property symbol
  // no longer carries. Only a genuinely missing expression relation may fall
  // back to the symbol relation; an ambiguous expression must stay ambiguous
  // instead of being erased by a convenient optional-origin fallback.
  const expressionOrigin = moduleOriginResolutionOfExpression(session, node.expression);
  const moduleOrigin =
    expressionOrigin.status === "resolved"
      ? expressionOrigin.origin
      : expressionOrigin.status === "missing"
        ? origin.moduleOrigin
        : undefined;
  return {
    ...result,
    calleeFacts: {
      symbol: calleeSymbol,
      ...definedFields({ moduleOrigin }),
      identity: origin.identity,
    },
  };
}

/**
 * The checker does not attach a symbol to an element-access expression even
 * when its key is a literal (`React["memo"]`). Resolve only that static form
 * through the receiver's type; an identifier, template, or other computed
 * key remains unresolved so wrapper policy cannot turn dynamic dispatch into
 * a React fact.
 */
function calleeSymbolAt(session: TsgoFactsSession, expression: Node) {
  const direct = session.symbolAt(expression);
  if (direct !== undefined) return direct;
  if (!isElementAccessExpression(expression) || !isStringLiteral(expression.argumentExpression)) {
    return undefined;
  }
  const receiverType = session.checker.getTypeAtLocation(expression.expression);
  if (receiverType === undefined) return undefined;
  const symbol = session.checker.getPropertyOfType(receiverType, expression.argumentExpression.text);
  return symbol === undefined ? undefined : session.symbolHandle(symbol);
}
