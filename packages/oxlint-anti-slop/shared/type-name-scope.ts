import type { ESTree } from "@oxlint/plugins";

import { isStaticMember, typeParameterNamesAt } from "./lexical-type-parameters.ts";
import type { VisitorKeys } from "./lexical-type-parameters.ts";

/**
 * Nearest lexical declaration binding a type name, or `shadowed` when a value, import, or
 * enum declaration makes the name — and any outer declaration it hides — unusable.
 */
export type TypeNameBinding =
	| { readonly kind: "alias"; readonly declaration: ESTree.TSTypeAliasDeclaration }
	| { readonly kind: "interface"; readonly declarations: readonly ESTree.TSInterfaceDeclaration[] }
	| { readonly kind: "shadowed" };

/** Lexical lookup of type names, indexed per declaration container. */
export type TypeNameScope = {
	/** Nearest lexical binding for `name` visible at `useSite`, or null when no local declaration binds it. */
	readonly resolve: (useSite: ESTree.Node, name: string) => TypeNameBinding | null;
};

type BindingCollector = {
	aliases: ESTree.TSTypeAliasDeclaration[];
	interfaces: ESTree.TSInterfaceDeclaration[];
	shadowed: boolean;
};

function declaredStatement(statement: ESTree.Node): ESTree.Node | null {
	return statement.type === "ExportNamedDeclaration" ||
		statement.type === "ExportDefaultDeclaration"
		? (statement.declaration ?? null)
		: statement;
}

function containerStatements(node: ESTree.Node): readonly ESTree.Node[] | null {
	if (
		node.type === "Program" ||
		node.type === "BlockStatement" ||
		node.type === "TSModuleBlock" ||
		node.type === "StaticBlock"
	) {
		return node.body;
	}
	// Every case of one switch shares the switch block's lexical scope.
	if (node.type === "SwitchStatement") return node.cases.flatMap((switchCase) => switchCase.consequent);
	return null;
}

function collector(entries: Map<string, BindingCollector>, name: string): BindingCollector {
	const existing = entries.get(name);
	if (existing !== undefined) return existing;
	const created: BindingCollector = { aliases: [], interfaces: [], shadowed: false };
	entries.set(name, created);
	return created;
}

function markShadowed(entries: Map<string, BindingCollector>, name: string): void {
	collector(entries, name).shadowed = true;
}

function identifierName(value: unknown): string | null {
	return typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "Identifier" &&
		"name" in value &&
		typeof value.name === "string"
		? value.name
		: null;
}

function recordDeclaration(entries: Map<string, BindingCollector>, declaration: ESTree.Node): void {
	switch (declaration.type) {
		case "ImportDeclaration": {
			for (const specifier of declaration.specifiers) {
				markShadowed(entries, specifier.local.name);
			}
			return;
		}
		case "TSTypeAliasDeclaration": {
			collector(entries, declaration.id.name).aliases.push(declaration);
			return;
		}
		case "TSInterfaceDeclaration": {
			collector(entries, declaration.id.name).interfaces.push(declaration);
			return;
		}
		case "TSEnumDeclaration": {
			markShadowed(entries, declaration.id.name);
			return;
		}
		case "ClassDeclaration": {
			if (declaration.id !== null) markShadowed(entries, declaration.id.name);
			return;
		}
		case "FunctionDeclaration":
		case "TSDeclareFunction":
			// Value-namespace only; a same-named type alias or built-in stays visible.
			return;
		case "TSModuleDeclaration": {
			if (declaration.id.type === "Identifier") markShadowed(entries, declaration.id.name);
			return;
		}
		case "TSImportEqualsDeclaration": {
			markShadowed(entries, declaration.id.name);
			return;
		}
		default: {
			if ("id" in declaration) {
				const name = identifierName(declaration.id);
				if (name !== null) markShadowed(entries, name);
			}
			return;
		}
	}
}

function bindingFromCollector(collected: BindingCollector): TypeNameBinding | null {
	const [alias] = collected.aliases;
	const hasAlias = alias !== undefined;
	const hasInterface = collected.interfaces.length > 0;
	if (collected.shadowed || collected.aliases.length > 1 || (hasAlias && hasInterface)) {
		return { kind: "shadowed" };
	}
	if (hasAlias) return { kind: "alias", declaration: alias };
	if (hasInterface) return { kind: "interface", declarations: collected.interfaces };
	return null;
}

function indexStatements(statements: readonly ESTree.Node[]): Map<string, TypeNameBinding> {
	const entries = new Map<string, BindingCollector>();
	for (const statement of statements) {
		const declaration = declaredStatement(statement);
		if (declaration !== null) recordDeclaration(entries, declaration);
	}
	const index = new Map<string, TypeNameBinding>();
	for (const [name, collected] of entries) {
		const binding = bindingFromCollector(collected);
		if (binding !== null) index.set(name, binding);
	}
	return index;
}

/**
 * Index the program's type declarations for lexical name lookup.
 *
 * @param program - The program whose declaration containers are indexed lazily.
 * @param visitorKeys - The ESTree visitor keys that name each node's child slots.
 * @returns A scope resolving names from a use site outward through lexical containers.
 */
export function createTypeNameScope(program: ESTree.Program, visitorKeys: VisitorKeys): TypeNameScope {
	const indexes = new Map<ESTree.Node, Map<string, TypeNameBinding>>();
	indexes.set(program, indexStatements(program.body));

	const indexOf = (container: ESTree.Node): Map<string, TypeNameBinding> | null => {
		const cached = indexes.get(container);
		if (cached !== undefined) return cached;
		const statements = containerStatements(container);
		if (statements === null) return null;
		const index = indexStatements(statements);
		indexes.set(container, index);
		return index;
	};

	return {
		resolve(useSite, name) {
			// Walk outward once, interleaving type binders with declaration
			// containers, so the nearest binding wins: an inner `type T` shadows
			// an outer `<T>`, and a class's own type parameters stop at its
			// static members.
			let current: ESTree.Node | null = useSite;
			let descendant: ESTree.Node = useSite;
			let staticMemberOwner: ESTree.Node | null = null;
			while (current !== null) {
				if (isStaticMember(current)) {
					const classBody = current.parent;
					staticMemberOwner = classBody !== null ? classBody.parent : null;
				}
				for (const binder of typeParameterNamesAt(current, descendant, visitorKeys, staticMemberOwner)) {
					if (binder === name) return { kind: "shadowed" };
				}
				const index = indexOf(current);
				if (index !== null) {
					const binding = index.get(name);
					if (binding !== undefined) return binding;
				}
				if (current.type === "Program") return null;
				descendant = current;
				current = current.parent;
			}
			return null;
		},
	};
}

function referencedAliasName(type: ESTree.TSType): string | null {
	if (type.type === "TSParenthesizedType") return referencedAliasName(type.typeAnnotation);
	if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return null;
	return type.typeArguments === null ||
		type.typeArguments === undefined ||
		type.typeArguments.params.length === 0
		? type.typeName.name
		: null;
}

/** The aliased type a bare type reference resolves to, with its extended alias-visit trail. */
type AliasTarget = {
	/** The aliased type to continue resolving. */
	readonly type: ESTree.TSType;

	/** Alias visit trail extended with the chased declaration, for the recursive resolution step. */
	readonly visitedAliases: ReadonlySet<ESTree.TSTypeAliasDeclaration>;
};

/**
 * Chase a bare type reference to the single non-generic alias it names.
 *
 * @param scope - The lexical type-name scope of the enclosing program.
 * @param type - The type node to resolve as a reference to a local alias.
 * @param visitedAliases - Aliases already chased while resolving `type`.
 * @returns The aliased type and extended visit trail, or null when `type` is not an unvisited
 *   reference to a non-generic alias.
 */
function resolveAliasTarget(
	scope: TypeNameScope,
	type: ESTree.TSType,
	visitedAliases: ReadonlySet<ESTree.TSTypeAliasDeclaration>,
): AliasTarget | null {
	const name = referencedAliasName(type);
	if (name === null) return null;
	const binding = scope.resolve(type, name);
	if (binding?.kind !== "alias" || visitedAliases.has(binding.declaration)) return null;
	const alias = binding.declaration;
	if (alias.typeParameters !== null && alias.typeParameters !== undefined) return null;
	const nextVisited = new Set(visitedAliases);
	nextVisited.add(alias);
	return { type: alias.typeAnnotation, visitedAliases: nextVisited };
}

/**
 * The first type argument of an unshadowed `Promise`/`PromiseLike` reference, or `undefined`
 * when the type is not such a reference. A locally declared or imported `Promise` is not the
 * built-in and stays an ordinary type.
 */
function unshadowedPromiseArgument(scope: TypeNameScope, type: ESTree.TSType): ESTree.TSType | undefined {
	if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return undefined;
	const name = type.typeName.name;
	if (name !== "Promise" && name !== "PromiseLike") return undefined;
	if (scope.resolve(type, name) !== null) return undefined;
	return type.typeArguments?.params[0];
}

/** How {@link resolvesThroughAliases} walks a type to its match. */
type AliasChaseOptions = {
	/** Whether a matching union member matches the union itself. Defaults to false. */
	readonly throughUnions?: boolean;

	/** Whether an unshadowed `Promise`/`PromiseLike` type argument continues the walk. Defaults to false. */
	readonly throughPromises?: boolean;

	/** Aliases already being resolved; seed with the declaration under test to stop self-chasing. */
	readonly visitedAliases?: ReadonlySet<ESTree.TSTypeAliasDeclaration>;
};

/**
 * Whether a type reaches a match through parentheses, local aliases, and the enabled container
 * steps.
 *
 * @param scope - The lexical type-name scope of the enclosing program.
 * @param type - The type node to chase.
 * @param matches - Whether the type itself matches the target.
 * @param options - Chase behavior and the seed alias-visit trail.
 * @returns True when the type reaches a match through the enabled steps.
 */
export function resolvesThroughAliases(
	scope: TypeNameScope,
	type: ESTree.TSType,
	matches: (type: ESTree.TSType) => boolean,
	options: AliasChaseOptions,
): boolean {
	const walk = (
		current: ESTree.TSType,
		visitedAliases: ReadonlySet<ESTree.TSTypeAliasDeclaration>,
	): boolean => {
		if (matches(current)) return true;
		if (options.throughPromises === true) {
			const promiseArgument = unshadowedPromiseArgument(scope, current);
			if (promiseArgument !== undefined && walk(promiseArgument, visitedAliases)) return true;
		}
		if (current.type === "TSParenthesizedType") return walk(current.typeAnnotation, visitedAliases);
		if (options.throughUnions === true && current.type === "TSUnionType") {
			return current.types.some((member) => walk(member, visitedAliases));
		}
		const alias = resolveAliasTarget(scope, current, visitedAliases);
		return alias !== null && walk(alias.type, alias.visitedAliases);
	};
	return walk(type, options.visitedAliases ?? new Set());
}
