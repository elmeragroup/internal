import type { ESTree } from "@oxlint/plugins";

import { lexicalTypeParameterNames } from "./lexical-type-parameters.ts";
import type { VisitorKeys } from "./lexical-type-parameters.ts";

export type TypeNameBinding =
	| { readonly kind: "alias"; readonly declaration: ESTree.TSTypeAliasDeclaration }
	| { readonly kind: "interface"; readonly declarations: readonly ESTree.TSInterfaceDeclaration[] }
	| { readonly kind: "shadowed" };

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
	if (node.type === "SwitchCase") return node.consequent;
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
		case "ClassDeclaration":
		case "FunctionDeclaration": {
			if (declaration.id !== null) markShadowed(entries, declaration.id.name);
			return;
		}
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
			if (lexicalTypeParameterNames(useSite, visitorKeys).has(name)) {
				return { kind: "shadowed" };
			}
			let current: ESTree.Node | null = useSite.parent;
			while (current !== null) {
				const index = indexOf(current);
				if (index !== null) {
					const binding = index.get(name);
					if (binding !== undefined) return binding;
				}
				if (current.type === "Program") return null;
				current = current.parent;
			}
			return null;
		},
	};
}
