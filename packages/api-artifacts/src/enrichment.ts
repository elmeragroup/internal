import type { ExtractionResult, PropertyNode, SemanticType } from "@elmeragroup/api-extractor";

import { dedupeDocumentation, readPartPropFact, shortTypeOf } from "./checker.ts";
import type { ComponentApi, LibraryProject } from "./checker.ts";
import type { ApiArtifactDiagnostic, ApiPart, ApiProp } from "./model.ts";

function propertiesOf(type: SemanticType): readonly PropertyNode[] {
  switch (type.kind) {
    case "component":
      return type.props;
    case "object":
      return type.properties;
    case "intersection":
      return [...type.properties, ...type.types.flatMap(propertiesOf)];
    case "union":
      return type.types.flatMap(propertiesOf);
    default:
      return [];
  }
}

function selectedProps(
  result: ExtractionResult,
  rootName: string,
  partName: string
): { properties: readonly PropertyNode[]; ownerPath: readonly string[] } | undefined {
  let type = result.module.exports.find((entry) => entry.name === rootName)?.type;
  const ownerPath = [rootName];
  if (partName !== rootName) {
    const memberName = partName.slice(rootName.length + 1);
    type =
      type?.kind === "object" ? type.properties.find((entry) => entry.name === memberName)?.type : undefined;
    ownerPath.push("properties", memberName);
  }
  if (type === undefined) return undefined;
  if (type.kind === "function") {
    const parameter = type.callSignatures[0]?.parameters[0];
    if (parameter === undefined) return undefined;
    return {
      properties: propertiesOf(parameter.type),
      ownerPath: [...ownerPath, "callSignatures", "0", "parameters", parameter.name, "properties"],
    };
  }
  return { properties: propertiesOf(type), ownerPath: [...ownerPath, "props"] };
}

function enrichPart(
  context: LibraryProject,
  component: ComponentApi,
  current: ApiPart,
  result: ExtractionResult,
  roots: readonly string[],
  packages: readonly string[]
): ApiPart {
  const root = roots.find((name) => current.name === name || current.name.startsWith(`${name}.`));
  const facts = component.partApis.find((part) => part.name === current.name);
  if (root === undefined || facts === undefined) return current;
  const selected = selectedProps(result, root, current.name);
  if (selected === undefined) return current;
  const names = new Set(current.props.map((prop) => prop.name));
  const additions: ApiProp[] = [];
  for (const property of selected.properties) {
    if (names.has(property.name)) continue;
    const propPath = [...selected.ownerPath, property.name];
    const provenance = result.provenance.find(
      (entry) =>
        entry.path.length === propPath.length &&
        entry.path.every((segment, index) => segment === propPath[index])
    );
    if (
      provenance?.synthesized === true ||
      provenance?.declarations.some((declaration) => declaration.owner?.kind === "project")
    )
      continue;
    const owners = [
      ...new Set(
        provenance?.declarations.flatMap((declaration) =>
          declaration.owner?.kind === "dependency" ? [declaration.owner.packageName] : []
        ) ?? []
      ),
    ];
    const packageName = owners.length === 1 ? owners[0] : undefined;
    const description = dedupeDocumentation(property.documentation?.description);
    if (packageName === undefined || !packages.includes(packageName) || description === "") continue;
    const fact = readPartPropFact(context, facts, property.name);
    if (fact === undefined) continue;
    if (fact.type === null)
      throw new Error(`${current.name}.${property.name}: selected dependency prop has an unresolvable type`);
    additions.push({
      name: property.name,
      origin: { packageName },
      type: fact.type,
      shortType: shortTypeOf(property.name, fact.type),
      defaultValue: facts.source?.defaults.get(property.name) ?? property.documentation?.defaultValue ?? null,
      description,
      required: fact.required,
    });
    names.add(property.name);
  }
  additions.sort((left, right) => left.name.localeCompare(right.name));
  if (additions.length > current.forwardedCount)
    throw new Error(`${current.name}: selected props exceed forwarded prop count`);
  return {
    ...current,
    props: [...current.props, ...additions],
    forwardedCount: current.forwardedCount - additions.length,
  };
}

export type EnrichedLibraryApi = {
  readonly components: readonly ComponentApi[];
  readonly diagnostics: readonly ApiArtifactDiagnostic[];
};

export function enrichComponents(
  context: LibraryProject,
  results: readonly ExtractionResult[],
  model: readonly ComponentApi[],
  packages: readonly string[]
): EnrichedLibraryApi {
  const diagnostics: ApiArtifactDiagnostic[] = [];
  const components = model.map((component, index) => {
    const result = results[index];
    if (result === undefined) throw new Error(`Missing extraction for ${component.slug}`);
    diagnostics.push(...result.warnings.map((warning) => ({ component: component.slug, warning })));
    return {
      ...component,
      parts: component.parts.map((part) =>
        enrichPart(context, component, part, result, component.exportNames, packages)
      ),
    };
  });
  return { components, diagnostics };
}
