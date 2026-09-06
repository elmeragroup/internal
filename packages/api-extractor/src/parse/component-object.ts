import type { BackendSymbolHandle, BackendTypeHandle } from "../backend/contracts.ts";
import type { PropertyNode, SemanticType } from "../model.ts";
import type { ProvenanceEntry } from "../provenance.ts";
import { componentNode } from "./component.ts";
import type { ResolveSemanticType, ResolverContext } from "./contracts.ts";
import { declarationProvenance, propertyTypeNode, recordProvenance } from "./object-resolver.ts";
import { componentPropSemanticPathFromProvenancePath, objectPropertySemanticPath } from "./semantic-paths.ts";

type Context = ResolverContext;

/**
 * Describes `export const Menu = { Root, Item }`: a module value whose every
 * member is a capitalized React component. Upstream degrades such a value to
 * `any` because an anonymous module value has no authored shape to anchor;
 * here the members ARE the shape, so the value becomes an object whose
 * properties are the member components. Returns `undefined` when any member
 * is not a component, which keeps the upstream fallback for ordinary values.
 */
export function componentObjectNode(
  type: BackendTypeHandle,
  context: Context,
  resolve: ResolveSemanticType
): SemanticType | undefined {
  if (context.provenancePath.length !== 1 || context.propertyDepth !== 0) return undefined;
  const members = context.operations.propertiesOfType(type);
  if (members.length === 0) return undefined;
  const properties: PropertyNode[] = [];
  const provenance: ProvenanceEntry[] = [];
  for (const member of members) {
    const resolved = componentMember(member, context, resolve, provenance);
    if (resolved === undefined) return undefined;
    properties.push(resolved);
  }
  for (const entry of provenance) recordProvenance(context, entry);
  return { kind: "object", properties };
}

function componentMember(
  member: BackendSymbolHandle,
  context: Context,
  resolve: ResolveSemanticType,
  provenance: ProvenanceEntry[]
): PropertyNode | undefined {
  const info = context.operations.symbolFacts(member);
  if (!/^[A-Z]/u.test(info.name)) return undefined;
  const memberType =
    context.operations.propertyType(member) ?? context.operations.typeOfSymbol(member, false);
  if (memberType === undefined) return undefined;
  const memberPath = objectPropertySemanticPath(context.provenancePath, info.name);
  const memberProvenance: ProvenanceEntry[] = [];
  const resolved = resolve(memberType, propertyTypeNode(member, context), member, {
    ...context,
    provenance: memberProvenance,
    provenancePath: memberPath,
    provenancePropertyContainer: "object",
    symbolStack: [...context.symbolStack, `property: ${info.name}`],
  });
  const component = componentNode(resolved, info.name, []);
  if (component.type.kind !== "component") return undefined;
  const propNames = new Set(component.type.props.map((property) => property.name));
  provenance.push({ path: memberPath, ...declarationProvenance(info, context) });
  for (const entry of memberProvenance) {
    const propPath = componentPropSemanticPathFromProvenancePath(entry.path, memberPath, propNames);
    if (propPath !== undefined) provenance.push({ ...entry, path: propPath });
  }
  const property: PropertyNode = {
    name: info.name,
    type: component.type,
    optional: info.flags.includes("optional"),
  };
  const docs = context.operations.documentationOfSymbol(member);
  if (docs !== undefined) Object.assign(property, { documentation: docs });
  return property;
}
