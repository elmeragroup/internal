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

type ResolvingAliases = ReadonlySet<ESTree.TSTypeAliasDeclaration>;

/** Alias type parameters bound to the arguments of one alias application. */
type TypeAliasEnvironment = ReadonlyMap<string, BoundType>;

/**
 * A type argument bound to an alias type parameter, read in the environment where the
 * argument was written rather than inside the alias it is passed to.
 */
type BoundType = {
	readonly type: ESTree.TSType;
	readonly substitutions: TypeAliasEnvironment;
	readonly resolvingAliases: ResolvingAliases;
};

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
	| "inline mapped"
	| "anonymous object"
	| "generic container"
	| "object"
	| "open dictionary"
	| "unknown";

/** A destination type a known value can flow into while losing its evidence. */
export type WideningTarget = {
	readonly kind: WideningTargetKind;
};

/**
 * The key set of a `Record` or mapped type: `open` when it admits arbitrary keys such as
 * `string`, `closed` when it is a finite set of literal keys, `empty` for `never`, and
 * `unresolved` when the key cannot be resolved locally, such as an imported alias or a type
 * parameter.
 */
type KeyDomain = "closed" | "empty" | "open" | "unresolved";

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

/**
 * Bind an alias's type parameters for one application. Explicit arguments keep the caller's
 * environment; defaults are read inside the alias, where earlier parameters are visible.
 *
 * @param alias - The applied alias.
 * @param type - The reference applying it.
 * @param base - The environment of the reference.
 * @param resolvingAliases - The aliases being resolved at the reference.
 * @returns The alias body's environment, or null when a parameter has neither argument nor default.
 */
function aliasSubstitution(
	alias: ESTree.TSTypeAliasDeclaration,
	type: ESTree.TSTypeReference,
	base: TypeAliasEnvironment,
	resolvingAliases: ResolvingAliases,
): TypeAliasEnvironment | null {
	const parameters = alias.typeParameters?.params ?? [];
	const arguments_ = type.typeArguments?.params ?? [];
	const insideAlias = new Set(resolvingAliases);
	insideAlias.add(alias);
	const next = new Map<string, BoundType>();
	for (const [index, parameter] of parameters.entries()) {
		const argument = arguments_[index];
		if (argument !== undefined) {
			next.set(parameter.name.name, {
				type: argument,
				substitutions: base,
				resolvingAliases,
			});
			continue;
		}
		if (parameter.default === null || parameter.default === undefined) return null;
		next.set(parameter.name.name, {
			type: parameter.default,
			substitutions: new Map(next),
			resolvingAliases: insideAlias,
		});
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
		return unsafeDirectValue(
			substitution.type,
			scope,
			substitution.substitutions,
			substitution.resolvingAliases,
		);
	}
	const binding = scope.resolve(unwrapped, name);
	if (binding?.kind === "interface") {
		return isEffectivelyEmptyInterface(binding.declarations) ? "empty-object" : null;
	}
	if (binding?.kind !== "alias" || resolvingAliases.has(binding.declaration)) return null;
	const alias = binding.declaration;
	const nextSubstitutions = aliasSubstitution(
		alias,
		unwrapped,
		substitutions,
		resolvingAliases,
	);
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
		return dictionaryValueTypes(
			substitution.type,
			scope,
			substitution.substitutions,
			substitution.resolvingAliases,
		);
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
	const nextSubstitutions = aliasSubstitution(
		alias,
		unwrapped,
		substitutions,
		resolvingAliases,
	);
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
	if (unwrapped.type === "TSMappedType") {
		return inlineMappedTarget(mappedKeyDomain(unwrapped, scope, new Map(), new Set()));
	}
	if (unwrapped.type !== "TSTypeReference") return null;
	const name = typeReferenceName(unwrapped);
	if (name === null) return null;
	if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(unwrapped, name, scope)) {
		const wrapped = unwrapped.typeArguments?.params[0];
		return wrapped === undefined ? null : classifyWideningTarget(wrapped, scope);
	}
	if (name === "Record" && isBuiltIn(unwrapped, name, scope)) {
		return inlineMappedTarget(recordKeyDomain(unwrapped, scope, new Map(), new Set()));
	}
	if ((name === "Pick" || name === "Omit") && isBuiltIn(unwrapped, name, scope)) {
		const resolved = classifyAliasBroadTarget(unwrapped, scope, new Map(), new Set());
		return resolved?.kind === "open dictionary" ? resolved : null;
	}
	const binding = scope.resolve(unwrapped, name);
	if (binding?.kind !== "alias") return null;
	const alias = binding.declaration;
	const substitutions = aliasSubstitution(alias, unwrapped, new Map(), new Set());
	if (substitutions === null) return null;
	const resolved = classifyAliasBroadTarget(
		alias.typeAnnotation,
		scope,
		substitutions,
		new Set([alias]),
	);
	if ((alias.typeParameters?.params.length ?? 0) === 0) return resolved;
	return resolved?.kind === "open dictionary" ? { kind: "generic container" } : null;
}

/**
 * An inline `Record` or mapped type has no named owner, so it is reported either way; only a
 * key domain that admits arbitrary keys makes it an open dictionary.
 */
function inlineMappedTarget(domain: KeyDomain): WideningTarget {
	return domain === "open" ? { kind: "open dictionary" } : { kind: "inline mapped" };
}

/** The keys a mapped type produces: its `as` clause when present, otherwise its constraint. */
function mappedKeyDomain(
	type: ESTree.TSMappedType,
	scope: TypeNameScope,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ResolvingAliases,
): KeyDomain {
	if (type.nameType === null) {
		return keyDomain(type.constraint, scope, substitutions, resolvingAliases);
	}
	const withKey = new Map(substitutions);
	withKey.set(type.key.name, { type: type.constraint, substitutions, resolvingAliases });
	return keyDomain(type.nameType, scope, withKey, resolvingAliases);
}

function recordKeyDomain(
	record: ESTree.TSTypeReference,
	scope: TypeNameScope,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ResolvingAliases,
): KeyDomain {
	const key = record.typeArguments?.params[0];
	return key === undefined
		? "unresolved"
		: keyDomain(key, scope, substitutions, resolvingAliases);
}

function unionKeyDomain(domains: readonly KeyDomain[]): KeyDomain {
	const members = domains.filter((domain) => domain !== "empty");
	if (members.length === 0) return "empty";
	if (members.includes("open")) return "open";
	return members.every((domain) => domain === "closed") ? "closed" : "unresolved";
}

/** A template literal type is empty when any interpolation is, as `${string}${never}` is `never`. */
function templateKeyDomain(domains: readonly KeyDomain[]): KeyDomain {
	return domains.includes("empty") ? "empty" : unionKeyDomain(domains);
}

function keyDomain(
	type: ESTree.TSType,
	scope: TypeNameScope,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ResolvingAliases,
): KeyDomain {
	const unwrapped = unwrapTransparentType(type);
	if (
		unwrapped.type === "TSAnyKeyword" ||
		unwrapped.type === "TSStringKeyword" ||
		unwrapped.type === "TSNumberKeyword" ||
		unwrapped.type === "TSSymbolKeyword"
	) {
		return "open";
	}
	if (unwrapped.type === "TSTypeOperator" && unwrapped.operator === "keyof") {
		return keyofKeyDomain(unwrapped.typeAnnotation, scope, substitutions, resolvingAliases);
	}
	if (unwrapped.type === "TSNeverKeyword") return "empty";
	if (unwrapped.type === "TSLiteralType") return "closed";
	if (unwrapped.type === "TSTemplateLiteralType" || unwrapped.type === "TSUnionType") {
		const domains = unwrapped.types.map((member) =>
			keyDomain(member, scope, substitutions, resolvingAliases),
		);
		return unwrapped.type === "TSTemplateLiteralType"
			? templateKeyDomain(domains)
			: unionKeyDomain(domains);
	}
	if (unwrapped.type !== "TSTypeReference") return "unresolved";
	const name = typeReferenceName(unwrapped);
	if (name === null) return "unresolved";
	const substitution = substitutions.get(name);
	if (substitution !== undefined) {
		return keyDomain(
			substitution.type,
			scope,
			substitution.substitutions,
			substitution.resolvingAliases,
		);
	}
	if (name === "PropertyKey" && isBuiltIn(unwrapped, name, scope)) return "open";
	const alias = resolvedAlias(unwrapped, name, scope, resolvingAliases);
	if (alias === null) return "unresolved";
	const nextSubstitutions = aliasSubstitution(
		alias,
		unwrapped,
		substitutions,
		resolvingAliases,
	);
	if (nextSubstitutions === null) return "unresolved";
	const nextResolving = new Set(resolvingAliases);
	nextResolving.add(alias);
	return keyDomain(alias.typeAnnotation, scope, nextSubstitutions, nextResolving);
}

/** An interface declaring its own index signature, with nothing inherited to inspect. */
function isOpenInterface(declarations: readonly ESTree.TSInterfaceDeclaration[]): boolean {
	return (
		declarations.every((declaration) => declaration.extends.length === 0) &&
		declarations.some((declaration) =>
			declaration.body.body.some((member) => member.type === "TSIndexSignature"),
		)
	);
}

/**
 * The keys of `keyof T`: open for `any`, `never` (whose keys are `PropertyKey`), or an open
 * dictionary; empty for an empty object type; closed for another object type literal.
 */
function keyofKeyDomain(
	type: ESTree.TSType,
	scope: TypeNameScope,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ResolvingAliases,
): KeyDomain {
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type === "TSAnyKeyword" || unwrapped.type === "TSNeverKeyword") return "open";
	if (unwrapped.type === "TSTypeReference") {
		const name = typeReferenceName(unwrapped);
		const substitution = name === null ? undefined : substitutions.get(name);
		if (substitution !== undefined) {
			return keyofKeyDomain(
				substitution.type,
				scope,
				substitution.substitutions,
				substitution.resolvingAliases,
			);
		}
		const binding = name === null ? null : scope.resolve(unwrapped, name);
		if (binding?.kind === "interface") {
			return isOpenInterface(binding.declarations) ? "open" : "unresolved";
		}
		const alias =
			name === null ? null : resolvedAlias(unwrapped, name, scope, resolvingAliases);
		if (alias !== null) {
			const nextSubstitutions = aliasSubstitution(
				alias,
				unwrapped,
				substitutions,
				resolvingAliases,
			);
			if (nextSubstitutions === null) return "unresolved";
			const nextResolving = new Set(resolvingAliases);
			nextResolving.add(alias);
			return keyofKeyDomain(alias.typeAnnotation, scope, nextSubstitutions, nextResolving);
		}
	}
	const target = classifyAliasBroadTarget(unwrapped, scope, substitutions, resolvingAliases);
	if (target?.kind === "open dictionary") return "open";
	if (unwrapped.type !== "TSTypeLiteral") return "unresolved";
	return unwrapped.members.length === 0 ? "empty" : "closed";
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
		const domain = mappedKeyDomain(unwrapped, scope, substitutions, resolvingAliases);
		return domain === "open" ? { kind: "open dictionary" } : null;
	}
	if (unwrapped.type !== "TSTypeReference") return null;
	const name = typeReferenceName(unwrapped);
	if (name === null) return null;
	const substitution = substitutions.get(name);
	if (substitution !== undefined) {
		return classifyAliasBroadTarget(
			substitution.type,
			scope,
			substitution.substitutions,
			substitution.resolvingAliases,
		);
	}
	if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(unwrapped, name, scope)) {
		const wrapped = unwrapped.typeArguments?.params[0];
		return wrapped === undefined
			? null
			: classifyAliasBroadTarget(wrapped, scope, substitutions, resolvingAliases);
	}
	if (name === "Record" && isBuiltIn(unwrapped, name, scope)) {
		const domain = recordKeyDomain(unwrapped, scope, substitutions, resolvingAliases);
		return domain === "open" ? { kind: "open dictionary" } : null;
	}
	if ((name === "Pick" || name === "Omit") && isBuiltIn(unwrapped, name, scope)) {
		const [source, keys] = unwrapped.typeArguments?.params ?? [];
		if (source === undefined) return null;
		const target = classifyAliasBroadTarget(source, scope, substitutions, resolvingAliases);
		if (target?.kind !== "open dictionary") return null;
		// `Omit` of literal keys keeps an open source's index signature; omitting open keys may
		// remove it, so that is not reported. `Pick` keeps only the keys it names.
		if (keys === undefined) return null;
		const keysDomain = keyDomain(keys, scope, substitutions, resolvingAliases);
		if (name === "Omit") return keysDomain === "open" ? null : target;
		return keysDomain === "open" ? target : null;
	}
	const alias = resolvedAlias(unwrapped, name, scope, resolvingAliases);
	if (alias === null) return null;
	const nextSubstitutions = aliasSubstitution(
		alias,
		unwrapped,
		substitutions,
		resolvingAliases,
	);
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
