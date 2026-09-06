import type {
  BackendNodeFacts,
  BackendDocumentation,
  BackendSignatureHandle,
  BackendSymbolFacts,
  BackendTypeHandle,
} from "../backend/contracts.ts";
import type { ClassMethod, ClassNode, ClassProperty, ConstructSignatureNode, TypeName } from "../model.ts";
import { definedFields, flagFields } from "../optional-fields.ts";
import type { ResolveSemanticType, ResolverContext } from "./contracts.ts";
import {
  declarationProvenance,
  omitTypeParameterSourceNode,
  propertyTypeNode,
  recordProvenance,
  resolveParameter,
  resolveSignatureNode,
} from "./object-resolver.ts";
import { primaryDeclaration } from "./ownership.ts";
import {
  constructSignatureSemanticPath,
  methodSemanticPath,
  objectPropertySemanticPath,
} from "./semantic-paths.ts";

type Context = ResolverContext;

/**
 * Members that appear on every class constructor type but are inherited from
 * `Function`; upstream skips the same names so a class API does not grow
 * built-in statics (`classTypeResolver.ts`).
 */
const functionBuiltInStaticNames = new Set(["prototype", "length", "name", "arguments", "caller"]);

/**
 * Builds a class node from a type's construct signatures.
 *
 * The static side of an exported class is what carries `new`, so it anchors
 * the node: its construct signatures become the public constructors, its own
 * members become the static half, and the first constructor's return type —
 * the instance side — contributes instance properties and methods. Members are
 * classified exactly as they were written: method declarations keep their
 * overload sets as methods, while function-typed properties and accessors stay
 * properties.
 *
 * A shape that merely declares `new (…)` without being a class (an interface or
 * object literal type) never reaches this resolver; upstream requires the same
 * class identity, and such shapes remain objects whose omitted signatures are
 * reported as warnings.
 */
export function resolveClassNode(
  type: BackendTypeHandle,
  constructs: readonly BackendSignatureHandle[],
  typeNameValue: TypeName | undefined,
  context: Context,
  resolveType: ResolveSemanticType
): ClassNode {
  const classPath = context.provenancePath;
  const constructSignatures = constructs.map((signature, index) =>
    resolveConstructSignature(
      signature,
      constructSignatureSemanticPath(classPath, index),
      context,
      resolveType
    )
  );
  // Instance members come first and static members follow, in checker order;
  // this is upstream's extraction order and it shows in member output.
  const properties: ClassProperty[] = [];
  const methods: ClassMethod[] = [];
  const firstConstruct = constructs.at(0);
  const instanceType =
    firstConstruct === undefined ? undefined : context.operations.signatureFacts(firstConstruct).returnType;
  if (instanceType !== undefined)
    extractMembers(instanceType, false, properties, methods, classPath, context, resolveType);
  extractMembers(type, true, properties, methods, classPath, context, resolveType);
  const result: ClassNode = {
    kind: "class",
    ...definedFields({ typeName: typeNameValue }),
    constructSignatures,
    properties,
    methods,
  };
  const typeParameters = declaredClassTypeParameters(type, context);
  if (typeParameters !== undefined && typeParameters.length > 0) Object.assign(result, { typeParameters });
  return result;
}

function resolveConstructSignature(
  signature: BackendSignatureHandle,
  signaturePath: readonly string[],
  context: Context,
  resolveType: ResolveSemanticType
): ConstructSignatureNode {
  context.operations.setErrorContext(context.symbolStack);
  const facts = context.operations.signatureFacts(signature);
  const result: ConstructSignatureNode = {
    parameters: facts.parameters.map((parameter) =>
      resolveParameter(parameter, signaturePath, context, resolveType, facts.declaration)
    ),
  };
  // Constructor documentation lives on the declaration's JSDoc; no checker
  // symbol carries it, so the backend reads it from the authored node.
  const documentation =
    facts.declaration === undefined ? undefined : context.operations.documentationOfNode(facts.declaration);
  if (documentation !== undefined) Object.assign(result, { documentation });
  return result;
}

function extractMembers(
  owner: BackendTypeHandle,
  isStatic: boolean,
  properties: ClassProperty[],
  methods: ClassMethod[],
  classPath: readonly string[],
  context: Context,
  resolveType: ResolveSemanticType
): void {
  for (const member of context.operations.propertiesOfType(owner)) {
    const info = context.operations.symbolFacts(member);
    // Upstream reads member documentation from the first declaration's
    // authored JSDoc (`getDocumentationFromSymbol`) and never from the
    // checker's aggregate — the aggregate would leak a constructor
    // parameter's summary onto the property it introduces.
    const primaryMemberDeclaration = info.declarations.at(0) ?? info.valueDeclaration;
    const docs =
      primaryMemberDeclaration === undefined
        ? undefined
        : context.operations.documentationOfNode(primaryMemberDeclaration);
    // JSDoc visibility and `@ignore` remove a member from the public surface
    // before any spelling-based rule runs.
    if (
      docs?.visibility === "private" ||
      docs?.visibility === "internal" ||
      docs?.tags.some((tag) => tag.name === "ignore")
    )
      continue;
    if (info.name.startsWith("_") || info.name.startsWith("#")) continue;
    if (isStatic && functionBuiltInStaticNames.has(info.name)) continue;
    const declaration = primaryDeclaration(info);
    if (declaration === undefined) continue;
    const declarationFacts = context.operations.nodeFacts(declaration);
    if (
      declarationFacts.declarationFlags?.some((flag) => flag === "private" || flag === "protected") === true
    )
      continue;
    const memberType =
      context.operations.propertyType(member) ?? context.operations.typeOfSymbol(member, false);
    const signatures = memberType === undefined ? [] : context.operations.signaturesOfType(memberType);
    // Upstream classifies a member as a method from either declaration kind —
    // MethodDeclaration or MethodSignature — so a signature merged in from
    // an interface stays a method instead of collapsing into a function-typed
    // property.
    if (
      (declarationFacts.kind === "method" || declarationFacts.kind === "methodSignature") &&
      signatures.length > 0
    ) {
      methods.push(resolveClassMethod(info, signatures, isStatic, classPath, docs, context, resolveType));
      continue;
    }
    const readonly = isReadOnlyMember(info, declarationFacts, context);
    recordProvenance(context, {
      path: objectPropertySemanticPath(classPath, info.name),
      ...declarationProvenance(info, context),
      ...flagFields({ readonly }),
    });
    const property: ClassProperty = {
      name: info.name,
      type: resolveType(
        memberType,
        omitTypeParameterSourceNode(propertyTypeNode(member, context), context),
        member,
        {
          ...context,
          provenancePath: objectPropertySemanticPath(classPath, info.name),
          provenancePropertyContainer: "object",
          symbolStack: [...context.symbolStack, `property: ${info.name}`],
          propertyDepth: context.propertyDepth + 1,
        }
      ),
      ...definedFields({ documentation: docs }),
      // Deliberately wider than upstream's authored `?` check: the checker's
      // `Optional` flag is accepted too, so checker-synthesized optionality
      // survives where upstream would report only the modifier.
      optional: info.flags.includes("optional") || declarationFacts.optional === true,
      readonly,
      isStatic,
    };
    properties.push(property);
  }
}

function resolveClassMethod(
  info: BackendSymbolFacts,
  signatures: readonly BackendSignatureHandle[],
  isStatic: boolean,
  classPath: readonly string[],
  docs: BackendDocumentation | undefined,
  context: Context,
  resolveType: ResolveSemanticType
): ClassMethod {
  const memberPath = methodSemanticPath(classPath, info.name);
  recordProvenance(context, { path: memberPath, ...declarationProvenance(info, context) });
  const method: ClassMethod = {
    name: info.name,
    ...definedFields({ documentation: docs }),
    isStatic,
    callSignatures: signatures.map((signature, index) =>
      resolveSignatureNode(signature, { ...context, provenancePath: memberPath }, index, resolveType)
    ),
  };
  return method;
}

/**
 * Readonly state across the three ways TypeScript authors it: a `readonly`
 * modifier on a property or a constructor parameter property, or a getter with
 * no paired setter. Upstream checks the same three forms.
 */
function isReadOnlyMember(
  info: BackendSymbolFacts,
  primaryDeclarationFacts: BackendNodeFacts,
  context: Context
): boolean {
  if (primaryDeclarationFacts.declarationFlags?.includes("readonly") === true) return true;
  const kinds = new Set(info.declarations.map((declaration) => context.operations.nodeKind(declaration)));
  return kinds.has("getAccessor") && !kinds.has("setAccessor");
}

/**
 * Type parameters authored on the class declaration itself.
 *
 * Only class *declarations* contribute them; a class expression has no
 * parameter list worth reporting, matching upstream's declaration check.
 */
function declaredClassTypeParameters(
  type: BackendTypeHandle,
  context: Context
): readonly TypeName[] | undefined {
  const symbol = context.operations.typeFacts(type).symbol;
  if (symbol === undefined) return undefined;
  for (const declaration of context.operations.symbolFacts(symbol).declarations) {
    if (context.operations.nodeKind(declaration) !== "class") continue;
    const parameters = context.operations.nodeFacts(declaration).typeParameters ?? [];
    return parameters.map((parameter) => ({
      name: context.operations.nodeFacts(parameter).name ?? "T",
    }));
  }
  return undefined;
}
