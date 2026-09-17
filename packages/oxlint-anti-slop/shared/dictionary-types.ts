import type { ESTree } from "@oxlint/plugins";

import { unwrapExpression } from "./expression-unwrapping.ts";
import type { TypeNameScope } from "./type-name-scope.ts";

const BUILT_INS = new Set([
	"Record",
	"Readonly",
	"Partial",
	"Required",
	"Pick",
	"Omit",
	"PropertyKey",
	"NonNullable",
]);
const TRANSPARENT_WRAPPERS = new Set(["Readonly", "Partial", "Required", "NonNullable"]);

type TypeAliasEnvironment = ReadonlyMap<string, ESTree.TSType>;

type ResolvedType = {
	readonly type: ESTree.TSType;
	readonly substitutions: TypeAliasEnvironment;
};

/** A dictionary contract whose direct value type is an escape hatch such as `unknown` or `any`. */
export type UnsafeDictionary = {
	readonly kind: "unsafe-dictionary";
	/** The escape hatch that makes values of this dictionary unsafe to consume. */
	readonly unsafeValue: "any" | "empty-object" | "object" | "union" | "unknown";
};

/** Broad destination shapes that discard a known value's type evidence. */
export type WideningTargetKind =
	| "anonymous object"
	| "generic container"
	| "object"
	| "open dictionary"
	| "unknown";

/** A destination type a known value can flow into while losing its evidence. */
export type WideningTarget = {
	readonly kind: WideningTargetKind;
};

type ResolvingAliases = ReadonlySet<ESTree.TSTypeAliasDeclaration>;

function typeReferenceName(type: ESTree.TSTypeReference): string | null {
	return type.typeName.type === "Identifier" ? type.typeName.name : null;
}

function isBuiltIn(
	reference: ESTree.Node,
	name: string,
	scope: TypeNameScope,
): boolean {
	return BUILT_INS.has(name) && scope.resolve(reference, name) === null;
}

function resolvedAlias(
	reference: ESTree.TSType,
	name: string,
	scope: TypeNameScope,
	resolvingAliases: ResolvingAliases,
): ESTree.TSTypeAliasDeclaration | null {
	const binding = scope.resolve(reference, name);
	if (binding?.kind !== "alias" || resolvingAliases.has(binding.declaration)) return null;
	return binding.declaration;
}

function isUnappliedReferenceTo(type: ESTree.TSType, name: string): boolean {
	const unwrapped = unwrapTransparentType(type);
	return (
		unwrapped.type === "TSTypeReference" &&
		typeReferenceName(unwrapped) === name &&
		(unwrapped.typeArguments === null ||
			unwrapped.typeArguments === undefined ||
			unwrapped.typeArguments.params.length === 0)
	);
}

function unwrapTransparentType(type: ESTree.TSType): ESTree.TSType {
	let current = type;
	while (
		current.type === "TSParenthesizedType" ||
		(current.type === "TSTypeOperator" && current.operator === "readonly")
	) {
		current = current.typeAnnotation;
	}
	return current;
}

function isNeverType(type: ESTree.TSType): boolean {
	return unwrapTransparentType(type).type === "TSNeverKeyword";
}

function isEffectivelyEmptyMember(member: ESTree.TSSignature): boolean {
	return (
		member.type === "TSPropertySignature" &&
		member.optional === true &&
		member.typeAnnotation !== null &&
		member.typeAnnotation !== undefined &&
		isNeverType(member.typeAnnotation.typeAnnotation)
	);
}

function isEffectivelyEmptyTypeLiteral(type: ESTree.TSTypeLiteral): boolean {
	return type.members.length === 0 || type.members.every(isEffectivelyEmptyMember);
}

function isEffectivelyEmptyInterface(
	declarations: readonly ESTree.TSInterfaceDeclaration[],
): boolean {
	if (declarations.length !== 1) return false;
	const [type] = declarations;
	return (
		type !== undefined &&
		type.extends.length === 0 &&
		(type.body.body.length === 0 || type.body.body.every(isEffectivelyEmptyMember))
	);
}

function resolvedSubstitutionArgument(
	type: ESTree.TSType,
	base: TypeAliasEnvironment,
	resolving: ReadonlySet<string> = new Set(),
): ESTree.TSType {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type !== "TSTypeReference") return type;
	const name = typeReferenceName(unwrapped);
	if (name === null || resolving.has(name)) return type;
	const substitution = base.get(name);
	if (substitution === undefined) return type;
	const nextResolving = new Set(resolving);
	nextResolving.add(name);
	return resolvedSubstitutionArgument(substitution, base, nextResolving);
}

function aliasSubstitution(
	alias: ESTree.TSTypeAliasDeclaration,
	type: ESTree.TSTypeReference,
	base: TypeAliasEnvironment,
): TypeAliasEnvironment | null {
	const parameters = alias.typeParameters?.params ?? [];
	const arguments_ = type.typeArguments?.params ?? [];
	const next = new Map(base);
	for (const [index, parameter] of parameters.entries()) {
		const argument = arguments_[index] ?? parameter.default;
		if (argument === null || argument === undefined) return null;
		next.set(parameter.name.name, resolvedSubstitutionArgument(argument, next));
	}
	return next;
}

function unsafeDirectValue(
	type: ESTree.TSType,
	scope: TypeNameScope,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ResolvingAliases,
): UnsafeDictionary["unsafeValue"] | null {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type === "TSUnknownKeyword") return "unknown";
	if (unwrapped.type === "TSAnyKeyword") return "any";
	if (unwrapped.type === "TSObjectKeyword") return "object";
	if (unwrapped.type === "TSTypeLiteral" && isEffectivelyEmptyTypeLiteral(unwrapped))
		return "empty-object";
	if (unwrapped.type === "TSUnionType") {
		return unwrapped.types.some(
			(member) => unsafeDirectValue(member, scope, substitutions, resolvingAliases) !== null,
		)
			? "union"
			: null;
	}
	if (unwrapped.type === "TSIntersectionType") {
		const unsafeMembers = unwrapped.types.map((member) =>
			unsafeDirectValue(member, scope, substitutions, resolvingAliases),
		);
		if (unsafeMembers.includes("any")) return "any";
		return unsafeMembers.length > 0 && unsafeMembers.every((member) => member !== null)
			? (unsafeMembers[0] ?? null)
			: null;
	}
	if (unwrapped.type !== "TSTypeReference") return null;
	const name = typeReferenceName(unwrapped);
	if (name === null) return null;
	if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(unwrapped, name, scope)) {
		const wrapped = unwrapped.typeArguments?.params[0];
		return wrapped === undefined
			? null
			: unsafeDirectValue(wrapped, scope, substitutions, resolvingAliases);
	}
	const substitution = substitutions.get(name);
	if (substitution !== undefined) {
		return isUnappliedReferenceTo(substitution, name)
			? null
			: unsafeDirectValue(substitution, scope, substitutions, resolvingAliases);
	}
	const binding = scope.resolve(unwrapped, name);
	if (binding?.kind === "interface") {
		return isEffectivelyEmptyInterface(binding.declarations) ? "empty-object" : null;
	}
	if (binding?.kind !== "alias" || resolvingAliases.has(binding.declaration)) return null;
	const alias = binding.declaration;
	const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions);
	if (nextSubstitutions === null) return null;
	const nextResolving = new Set(resolvingAliases);
	nextResolving.add(alias);
	return unsafeDirectValue(alias.typeAnnotation, scope, nextSubstitutions, nextResolving);
}

function dictionaryValueTypes(
	type: ESTree.TSType,
	scope: TypeNameScope,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ResolvingAliases,
): readonly ResolvedType[] {
	const unwrapped = unwrapTransparentType(type);

	if (unwrapped.type === "TSTypeLiteral") {
		return unwrapped.members.flatMap((member): readonly ResolvedType[] =>
			member.type === "TSIndexSignature" && member.typeAnnotation !== null
				? [{ type: member.typeAnnotation.typeAnnotation, substitutions }]
				: [],
		);
	}

	if (unwrapped.type === "TSMappedType") {
		return unwrapped.typeAnnotation === null
			? []
			: [{ type: unwrapped.typeAnnotation, substitutions }];
	}

	if (unwrapped.type !== "TSTypeReference") return [];
	const name = typeReferenceName(unwrapped);
	if (name === null) return [];

	const substitution = substitutions.get(name);
	if (substitution !== undefined) {
		return isUnappliedReferenceTo(substitution, name)
			? []
			: dictionaryValueTypes(substitution, scope, substitutions, resolvingAliases);
	}

	if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(unwrapped, name, scope)) {
		const wrapped = unwrapped.typeArguments?.params[0];
		return wrapped === undefined
			? []
			: dictionaryValueTypes(wrapped, scope, substitutions, resolvingAliases);
	}

	if (name === "Record" && isBuiltIn(unwrapped, name, scope)) {
		const value = unwrapped.typeArguments?.params[1] ?? null;
		return value === null ? [] : [{ type: value, substitutions }];
	}

	if ((name === "Pick" || name === "Omit") && isBuiltIn(unwrapped, name, scope)) {
		const source = unwrapped.typeArguments?.params[0];
		return source === undefined
			? []
			: dictionaryValueTypes(source, scope, substitutions, resolvingAliases);
	}

	const alias = resolvedAlias(unwrapped, name, scope, resolvingAliases);
	if (alias === null) return [];
	const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions);
	if (nextSubstitutions === null) return [];
	const nextResolving = new Set(resolvingAliases);
	nextResolving.add(alias);
	return dictionaryValueTypes(alias.typeAnnotation, scope, nextSubstitutions, nextResolving);
}

/**
 * Classify a dictionary value type used directly by a contract such as an index signature.
 *
 * @param valueType - The dictionary value type to classify.
 * @param scope - The lexical type scope of the enclosing program.
 * @returns The unsafe classification, or null when the value type is a concrete contract.
 */
export function classifyUnsafeDictionaryValue(
	valueType: ESTree.TSType,
	scope: TypeNameScope,
): UnsafeDictionary | null {
	const unsafeValue = unsafeDirectValue(valueType, scope, new Map(), new Set());
	return unsafeValue === null ? null : { kind: "unsafe-dictionary", unsafeValue };
}

/**
 * Classify a dictionary-shaped type by its direct value types, following aliases and wrappers.
 *
 * @param type - The candidate dictionary type to classify.
 * @param scope - The lexical type scope of the enclosing program.
 * @returns The unsafe classification, or null when the type is not an unsafe dictionary.
 */
export function classifyUnsafeDictionary(
	type: ESTree.TSType,
	scope: TypeNameScope,
): UnsafeDictionary | null {
	for (const valueType of dictionaryValueTypes(type, scope, new Map(), new Set())) {
		const unsafeValue = unsafeDirectValue(
			valueType.type,
			scope,
			valueType.substitutions,
			new Set(),
		);
		if (unsafeValue !== null) return { kind: "unsafe-dictionary", unsafeValue };
	}
	return null;
}

function resolvesToDictionary(
	type: ESTree.TSType,
	scope: TypeNameScope,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ResolvingAliases,
): boolean {
	return dictionaryValueTypes(type, scope, substitutions, resolvingAliases).length > 0;
}

/**
 * Classify a type as a broad destination that discards a known value's evidence.
 *
 * @param type - The destination type to classify.
 * @param scope - The lexical type scope of the enclosing program.
 * @returns The widening classification, or null when the destination keeps precise evidence.
 */
export function classifyWideningTarget(
	type: ESTree.TSType,
	scope: TypeNameScope,
): WideningTarget | null {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type === "TSUnknownKeyword") return { kind: "unknown" };
	if (unwrapped.type === "TSObjectKeyword") return { kind: "object" };
	if (unwrapped.type === "TSTypeLiteral") {
		return unwrapped.members.some((member) => member.type === "TSIndexSignature")
			? { kind: "open dictionary" }
			: unwrapped.members.length > 0
				? { kind: "anonymous object" }
				: null;
	}
	if (unwrapped.type === "TSMappedType") return { kind: "open dictionary" };
	if (unwrapped.type !== "TSTypeReference") return null;
	const name = typeReferenceName(unwrapped);
	if (name === null) return null;
	if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(unwrapped, name, scope)) {
		const wrapped = unwrapped.typeArguments?.params[0];
		return wrapped === undefined ? null : classifyWideningTarget(wrapped, scope);
	}
	if (name === "Record" && isBuiltIn(unwrapped, name, scope))
		return { kind: "open dictionary" };
	const binding = scope.resolve(unwrapped, name);
	if (binding?.kind !== "alias") return null;
	const alias = binding.declaration;
	if ((alias.typeParameters?.params.length ?? 0) > 0) {
		const substitutions = aliasSubstitution(alias, unwrapped, new Map());
		return substitutions !== null &&
			resolvesToDictionary(alias.typeAnnotation, scope, substitutions, new Set([alias]))
			? { kind: "generic container" }
			: null;
	}
	const substitutions = aliasSubstitution(alias, unwrapped, new Map());
	if (substitutions === null) return null;
	const resolved = classifyAliasBroadTarget(
		alias.typeAnnotation,
		scope,
		substitutions,
		new Set([alias]),
	);
	return resolved;
}

function isBroadMappedKey(
	type: ESTree.TSType,
	scope: TypeNameScope,
	substitutions: TypeAliasEnvironment,
): boolean {
	const unwrapped = unwrapTransparentType(type);
	if (
		unwrapped.type === "TSStringKeyword" ||
		unwrapped.type === "TSNumberKeyword" ||
		unwrapped.type === "TSSymbolKeyword"
	) {
		return true;
	}
	if (unwrapped.type === "TSUnionType") {
		return unwrapped.types.every((member) =>
			isBroadMappedKey(member, scope, substitutions),
		);
	}
	if (unwrapped.type !== "TSTypeReference") return false;
	const name = typeReferenceName(unwrapped);
	if (name === null) return false;
	const substitution = substitutions.get(name);
	if (substitution !== undefined && !isUnappliedReferenceTo(substitution, name)) {
		return isBroadMappedKey(substitution, scope, substitutions);
	}
	return name === "PropertyKey" && isBuiltIn(unwrapped, name, scope);
}

function classifyAliasBroadTarget(
	type: ESTree.TSType,
	scope: TypeNameScope,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ResolvingAliases,
): WideningTarget | null {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type === "TSUnknownKeyword") return { kind: "unknown" };
	if (unwrapped.type === "TSObjectKeyword") return { kind: "object" };
	if (unwrapped.type === "TSTypeLiteral") {
		return unwrapped.members.some((member) => member.type === "TSIndexSignature")
			? { kind: "open dictionary" }
			: null;
	}
	if (unwrapped.type === "TSMappedType") {
		return isBroadMappedKey(unwrapped.constraint, scope, substitutions)
			? { kind: "open dictionary" }
			: null;
	}
	if (unwrapped.type !== "TSTypeReference") return null;
	const name = typeReferenceName(unwrapped);
	if (name === null) return null;
	const substitution = substitutions.get(name);
	if (substitution !== undefined) {
		return isUnappliedReferenceTo(substitution, name)
			? null
			: classifyAliasBroadTarget(
					substitution,
					scope,
					substitutions,
					resolvingAliases,
				);
	}
	if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(unwrapped, name, scope)) {
		const wrapped = unwrapped.typeArguments?.params[0];
		return wrapped === undefined
			? null
			: classifyAliasBroadTarget(wrapped, scope, substitutions, resolvingAliases);
	}
	if (name === "Record" && isBuiltIn(unwrapped, name, scope)) {
		return { kind: "open dictionary" };
	}
	const alias = resolvedAlias(unwrapped, name, scope, resolvingAliases);
	if (alias === null) return null;
	const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions);
	if (nextSubstitutions === null) return null;
	const nextResolving = new Set(resolvingAliases);
	nextResolving.add(alias);
	return classifyAliasBroadTarget(
		alias.typeAnnotation,
		scope,
		nextSubstitutions,
		nextResolving,
	);
}

/**
 * Whether an expression syntactically establishes its own value, such as an object literal.
 *
 * @param expression - The expression to inspect.
 * @returns True when the expression carries known evidence without a variable reference.
 */
export function isKnownEvidenceExpression(expression: ESTree.Expression): boolean {
	const current = unwrapExpression(expression);
	if (current.type === "ObjectExpression") return true;
	return (
		current.type === "ArrayExpression" ||
		current.type === "ArrowFunctionExpression" ||
		current.type === "ClassExpression" ||
		current.type === "FunctionExpression" ||
		current.type === "NewExpression" ||
		current.type === "Literal" ||
		current.type === "TemplateLiteral" ||
		current.type === "UnaryExpression"
	);
}
