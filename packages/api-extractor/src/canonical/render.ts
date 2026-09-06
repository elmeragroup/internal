import type { CallSignatureNode, ParameterNode, PropertyNode, SemanticType, TypeName } from "../model.ts";

/**
 * Renders the upstream `toString()` form of a semantic type.
 *
 * The rendering is not decoration: compound canonicalization compares many
 * member pairs by rendered identity before falling back to structural
 * comparison, so the string form is part of the deduplication contract and
 * must stay byte-compatible with `typescript-api-extractor` at `e145350`.
 */
export function renderType(type: SemanticType): string {
  const name = typeNameOf(type);
  if (name !== undefined) return renderTypeName(name);
  switch (type.kind) {
    case "array": {
      const element = renderType(type.elementType);
      const wrapped = requiresElementParentheses(type.elementType) ? `(${element})` : element;
      return `${type.isReadonly === true ? "readonly " : ""}${wrapped}[]`;
    }
    case "class":
      return "class";
    case "component":
      return "";
    case "enum":
      return renderTypeName(type.typeName);
    case "external":
      return renderTypeName(type.typeName);
    case "function":
      return type.callSignatures.map(renderCallSignature).join(" | ");
    case "intersection":
      return `(${type.types.map(renderType).join(" & ")})`;
    case "intrinsic":
      return type.intrinsic;
    case "literal":
      return JSON.stringify(type.value);
    case "object":
      return renderObjectBody(type.properties, type.indexSignature);
    case "tuple":
      return `${type.isReadonly === true ? "readonly " : ""}[${type.types.map(renderType).join(", ")}]`;
    case "typeOperator": {
      const operand = renderType(type.type);
      return `${type.operator} ${type.type.kind === "function" ? `(${operand})` : operand}`;
    }
    case "typeParameter":
      return type.name;
    case "typeQuery":
      return `typeof ${type.expressionName}`;
    case "union":
      return `(${type.types.map(renderType).join(" | ")})`;
  }
}

/** The public alias of a type, or `undefined` for structural forms. */
export function typeNameOf(type: SemanticType): TypeName | undefined {
  if (type.kind === "typeParameter" || type.kind === "typeQuery") return undefined;
  // An enum or external node always carries its name; the rest are optional.
  return type.typeName;
}

/** Renders a public alias with its namespaces and type arguments. */
export function renderTypeName(name: TypeName): string {
  const args = name.typeArguments ?? [];
  const rendered =
    args.length === 0
      ? name.name
      : `${name.name}<${args.map((argument) => renderType(argument.type)).join(", ")}>`;
  const namespaces = name.namespaces ?? [];
  return namespaces.length === 0 ? rendered : `${namespaces.join(".")}.${rendered}`;
}

function renderCallSignature(signature: CallSignatureNode): string {
  const typeParameters = signature.typeParameters ?? [];
  const prefix =
    typeParameters.length === 0 ? "" : `<${typeParameters.map((parameter) => parameter.name).join(", ")}>`;
  const parameters = signature.parameters.map(renderParameter).join(", ");
  return `${prefix}(${parameters}) => ${renderType(signature.returnValueType)}`;
}

function renderParameter(parameter: ParameterNode): string {
  const optional = parameter.optional ? "?" : "";
  const initializer = parameter.defaultValue === undefined ? "" : ` = ${parameter.defaultValue}`;
  return `${parameter.name}: ${renderType(parameter.type)}${optional}${initializer}`;
}

function renderObjectBody(
  properties: readonly PropertyNode[],
  indexSignature: Extract<SemanticType, { kind: "object" }>["indexSignature"]
): string {
  const parts: string[] = [];
  if (indexSignature !== undefined) {
    const keyName = indexSignature.keyName ?? "key";
    parts.push(`[${keyName}: ${indexSignature.keyType}]: ${renderType(indexSignature.valueType)}`);
  }
  for (const property of properties) {
    parts.push(`${property.name}${property.optional ? "?:" : ":"} ${renderType(property.type)}`);
  }
  return `{ ${parts.join(", ")} }`;
}

/**
 * TypeScript's `readonly` modifier binds to the array or tuple that follows it,
 * so an unaliased readonly container used as an element needs parentheses.
 */
function requiresElementParentheses(element: SemanticType): boolean {
  if (element.kind === "typeOperator" || element.kind === "function") return true;
  if (element.kind === "array" || element.kind === "tuple") {
    return element.typeName === undefined && element.isReadonly === true;
  }
  return false;
}
