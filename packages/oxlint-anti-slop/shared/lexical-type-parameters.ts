import type { ESTree } from "@oxlint/plugins";

/** ESTree visitor keys naming each node type's child slots. */
export type VisitorKeys = Readonly<Record<string, readonly string[]>>;

function isNode(value: unknown): value is ESTree.Node {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		typeof value.type === "string"
	);
}

function collectInferTypeParameterNames(
	node: ESTree.Node,
	visitorKeys: VisitorKeys,
	names: Set<string>,
): void {
	if (node.type === "TSInferType") names.add(node.typeParameter.name.name);
	// SAFETY: ESTree.Node has no index signature; visitorKeys[node.type] names only known child slots on this node.
	const record = node as unknown as Readonly<Record<string, unknown>>;
	for (const key of visitorKeys[node.type] ?? []) {
		const value = record[key];
		if (isNode(value)) {
			collectInferTypeParameterNames(value, visitorKeys, names);
			continue;
		}
		if (!Array.isArray(value)) continue;
		for (const child of value) {
			if (isNode(child)) collectInferTypeParameterNames(child, visitorKeys, names);
		}
	}
}

/** Collect type binders that are in scope at a node and can shadow module aliases. */
export function typeParameterNamesAt(
	node: ESTree.Node,
	descendant: ESTree.Node,
	visitorKeys: VisitorKeys,
	staticMemberOwner: ESTree.Node | null = null,
): readonly string[] {
	const names = new Set<string>();
	// A class's own type parameters are not in scope inside its static members
	// or static blocks; an enclosing class's parameters still are.
	const classOwnsStaticMember =
		staticMemberOwner === node &&
		(node.type === "ClassDeclaration" || node.type === "ClassExpression");
	if ("typeParameters" in node && !classOwnsStaticMember) {
		for (const parameter of node.typeParameters?.params ?? []) {
			names.add(parameter.name.name);
		}
	}
	if (
		node.type === "TSMappedType" &&
		(descendant === node.nameType || descendant === node.typeAnnotation)
	) {
		names.add(node.key.name);
	}
	if (node.type === "TSConditionalType" && descendant === node.trueType) {
		collectInferTypeParameterNames(node.extendsType, visitorKeys, names);
	}
	return [...names];
}

/** Whether the node is a class member or block that cannot see the class's own type parameters. */
export function isStaticMember(node: ESTree.Node): boolean {
	if (node.type === "StaticBlock") return true;
	return "static" in node && node.static === true;
}
