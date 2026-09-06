import type { ModuleNode, SemanticType } from "../model.ts";

/** A structural path into the final semantic module model. */
export type SemanticPath = readonly string[];

export function exportSemanticPath(name: string): SemanticPath {
  return [name];
}

export function objectPropertySemanticPath(ownerPath: SemanticPath, name: string): SemanticPath {
  return [...ownerPath, "properties", name];
}

export function componentPropSemanticPath(ownerPath: SemanticPath, name: string): SemanticPath {
  return [...ownerPath, "props", name];
}

export function methodSemanticPath(ownerPath: SemanticPath, name: string): SemanticPath {
  return [...ownerPath, "methods", name];
}

export function callSignatureSemanticPath(ownerPath: SemanticPath, index: number): SemanticPath {
  return [...ownerPath, "callSignatures", String(index)];
}

export function constructSignatureSemanticPath(ownerPath: SemanticPath, index: number): SemanticPath {
  return [...ownerPath, "constructSignatures", String(index)];
}

export function parameterSemanticPath(signaturePath: SemanticPath, name: string): SemanticPath {
  return [...signaturePath, "parameters", name];
}

export function returnValueSemanticPath(signaturePath: SemanticPath): SemanticPath {
  return [...signaturePath, "returnValueType"];
}

export function enumMemberSemanticPath(enumPath: SemanticPath, name: string): SemanticPath {
  return [...enumPath, "members", name];
}

/**
 * The path of an index signature's key.
 *
 * A key is the one part of a container that has no property name to hang
 * provenance on, and a mapped type's key is synthesized outright. Giving it an
 * explicit path is what lets the sidecar say where a key came from — and
 * whether anyone declared it — without leaking a compiler handle.
 */
export function indexSignatureKeySemanticPath(ownerPath: SemanticPath): SemanticPath {
  return [...ownerPath, "indexSignature", "key"];
}

/**
 * Maps a provenance path from an authored component function/object to the
 * component's final public prop path.
 *
 * Component props can be discovered either from an authored props object or
 * from a function parameter. Both source shapes collapse into the same
 * `props` collection in the final semantic model, so the source grammar is
 * kept here with the rest of the path constructors. Only the prefix that
 * names the prop is rewritten: an entry nested under the prop (a render
 * callback's parameter, a member of an object-typed prop) keeps its own
 * path below `props.<name>`, so the prop's entry lists the prop's
 * declarations alone rather than the union of every descendant's.
 */
export function componentPropSemanticPathFromProvenancePath(
  path: SemanticPath,
  componentPath: SemanticPath,
  propertyNames: ReadonlySet<string>
): SemanticPath | undefined {
  if (!startsWithPath(path, componentPath)) return undefined;
  const located = componentPropertyFromProvenancePath(path.slice(componentPath.length));
  return located !== undefined && propertyNames.has(located.name)
    ? [...componentPropSemanticPath(componentPath, located.name), ...located.rest]
    : undefined;
}

function semanticPathKey(path: SemanticPath): string {
  return JSON.stringify(path);
}

/**
 * Collects the paths represented by the final semantic model. Keeping this
 * grammar beside the constructors makes provenance validation and resolver
 * writes agree on the same tree instead of each growing its own traversal.
 */
export function collectSemanticPaths(module: ModuleNode): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const entry of module.exports) {
    const path = exportSemanticPath(entry.name);
    addPath(paths, path);
    collectSemanticTypePaths(entry.type, path, paths);
  }
  return paths;
}

function collectSemanticTypePaths(type: SemanticType, path: SemanticPath, paths: Set<string>): void {
  if (type.kind === "object" || type.kind === "intersection") {
    for (const property of type.properties) {
      const propertyPath = objectPropertySemanticPath(path, property.name);
      addPath(paths, propertyPath);
      collectSemanticTypePaths(property.type, propertyPath, paths);
    }
  }
  if (type.kind === "component") {
    for (const property of type.props) {
      const propertyPath = componentPropSemanticPath(path, property.name);
      addPath(paths, propertyPath);
      collectSemanticTypePaths(property.type, propertyPath, paths);
    }
  }
  if (type.kind === "function") {
    type.callSignatures.forEach((signature, index) => {
      const signaturePath = callSignatureSemanticPath(path, index);
      addPath(paths, signaturePath);
      for (const parameter of signature.parameters) {
        const parameterPath = parameterSemanticPath(signaturePath, parameter.name);
        addPath(paths, parameterPath);
        collectSemanticTypePaths(parameter.type, parameterPath, paths);
      }
      const returnPath = returnValueSemanticPath(signaturePath);
      addPath(paths, returnPath);
      collectSemanticTypePaths(signature.returnValueType, returnPath, paths);
    });
  }
  if (type.kind === "enum") {
    for (const member of type.members) addPath(paths, enumMemberSemanticPath(path, member.name));
  }
  if (type.kind === "class") {
    type.constructSignatures.forEach((signature, index) => {
      const signaturePath = constructSignatureSemanticPath(path, index);
      addPath(paths, signaturePath);
      for (const parameter of signature.parameters) {
        const parameterPath = parameterSemanticPath(signaturePath, parameter.name);
        addPath(paths, parameterPath);
        collectSemanticTypePaths(parameter.type, parameterPath, paths);
      }
    });
    for (const property of type.properties) {
      const propertyPath = objectPropertySemanticPath(path, property.name);
      addPath(paths, propertyPath);
      collectSemanticTypePaths(property.type, propertyPath, paths);
    }
    for (const method of type.methods) {
      const methodPath = methodSemanticPath(path, method.name);
      addPath(paths, methodPath);
      method.callSignatures.forEach((signature, index) => {
        const signaturePath = callSignatureSemanticPath(methodPath, index);
        addPath(paths, signaturePath);
        for (const parameter of signature.parameters) {
          const parameterPath = parameterSemanticPath(signaturePath, parameter.name);
          addPath(paths, parameterPath);
          collectSemanticTypePaths(parameter.type, parameterPath, paths);
        }
        const returnPath = returnValueSemanticPath(signaturePath);
        addPath(paths, returnPath);
        collectSemanticTypePaths(signature.returnValueType, returnPath, paths);
      });
    }
  }
  if (type.kind === "union" || type.kind === "intersection")
    for (const member of type.types) collectSemanticTypePaths(member, path, paths);
  // A container is transparent in the path grammar: its members carry the
  // container's own path, so a nested property is addressed the same way
  // whether or not an array, tuple, or index signature sits in between.
  if (type.kind === "object" && type.indexSignature !== undefined) {
    addPath(paths, indexSignatureKeySemanticPath(path));
    collectSemanticTypePaths(type.indexSignature.valueType, path, paths);
  }
  if (type.kind === "array") collectSemanticTypePaths(type.elementType, path, paths);
  if (type.kind === "tuple") for (const member of type.types) collectSemanticTypePaths(member, path, paths);
  if (type.kind === "typeOperator") {
    collectSemanticTypePaths(type.type, path, paths);
    collectSemanticTypePaths(type.resolvedType, path, paths);
  }
}

/** The prop a source-shape path addresses, and the path that continues below it. */
function componentPropertyFromProvenancePath(
  path: SemanticPath
): { readonly name: string; readonly rest: SemanticPath } | undefined {
  if (path[0] === "properties") {
    return path[1] === undefined ? undefined : { name: path[1], rest: path.slice(2) };
  }
  if (path[0] !== "callSignatures" || path[2] !== "parameters" || path[3] === undefined) return undefined;
  if (path[4] !== "properties" || path[5] === undefined) return undefined;
  return { name: path[5], rest: path.slice(6) };
}

function startsWithPath(path: SemanticPath, prefix: SemanticPath): boolean {
  return path.length >= prefix.length && prefix.every((segment, index) => path[index] === segment);
}

function addPath(paths: Set<string>, path: SemanticPath): void {
  paths.add(semanticPathKey(path));
}
