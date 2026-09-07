import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { ProjectExtractor } from "@elmeragroup/api-extractor";
import type { ComponentSourceResult, ExtractWarning, ExtractionResult } from "@elmeragroup/api-extractor";

import { componentPartRequests, extractPart, openLibraryProject } from "./checker.ts";
import type { ComponentApi, LibraryProject, PartRequest } from "./checker.ts";
import { enrichComponents } from "./enrichment.ts";
import { ApiArtifactsDriftError, ApiArtifactsError, ProblemLog } from "./errors.ts";
import type { ApiArtifactDiagnostic } from "./model.ts";
import type { ComponentApiArtifact } from "./model.ts";

export type ApiArtifactComponent = {
  readonly slug: string;
  /** Absolute or relative to projectRoot. */
  readonly entryFile: string;
  readonly exportNames: readonly string[];
  /** Absolute or relative to projectRoot. Must end in .json. */
  readonly outputFile: string;
};
export type GenerateApiArtifactsOptions = {
  readonly projectRoot: string;
  readonly tsconfigPath: string;
  readonly components: readonly ApiArtifactComponent[];
  readonly includeExternalTypes?: readonly string[];
  /** Accepted warnings remain visible in the returned diagnostics. */
  readonly allowedWarningCodes?: readonly ExtractWarning["code"][];
  readonly mode?: "write" | "check";
  /** Optional consumer-specific regeneration instructions. */
  readonly generatedBy?: string;
};
export type GeneratedApiComponent = ComponentApiArtifact & {
  readonly outputFile: string;
  readonly text: string;
  readonly changed: boolean;
};
export type GenerateApiArtifactsResult = {
  readonly components: readonly GeneratedApiComponent[];
  readonly diagnostics: readonly ApiArtifactDiagnostic[];
};

function requestsFor(options: GenerateApiArtifactsOptions): readonly ApiArtifactComponent[] {
  const slugs = new Set<string>();
  const outputs = new Set<string>();
  return options.components.map((component) => {
    const entryFile = path.resolve(options.projectRoot, component.entryFile);
    const outputFile = path.resolve(options.projectRoot, component.outputFile);
    if (!component.slug.trim() || slugs.has(component.slug))
      throw new ApiArtifactsError([`Empty or duplicate component slug: ${component.slug}`]);
    if (outputFile === path.resolve(options.projectRoot, options.tsconfigPath))
      throw new ApiArtifactsError(["The tsconfig cannot be an artifact output"]);
    if (outputs.has(outputFile) || !outputFile.endsWith(".json"))
      throw new ApiArtifactsError([`Duplicate or non-JSON output: ${outputFile}`]);
    if (
      component.exportNames.length === 0 ||
      new Set(component.exportNames).size !== component.exportNames.length ||
      component.exportNames.some((name) => !name.trim())
    )
      throw new ApiArtifactsError([`${component.slug}: provide unique, non-empty export names`]);
    slugs.add(component.slug);
    outputs.add(outputFile);
    return { ...component, entryFile, outputFile };
  });
}

async function existingText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Replaces complete files; a reader never sees a partially written JSON document. */
async function writeArtifact(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function describeComponent(
  context: LibraryProject,
  request: ApiArtifactComponent,
  parts: readonly PartRequest[],
  inspected: readonly ComponentSourceResult[],
  problems: ProblemLog
): ComponentApi {
  if (inspected.length !== parts.length) {
    throw new ApiArtifactsError([
      `${request.slug}: source inspection returned ${inspected.length} results for ${parts.length} parts`,
    ]);
  }
  const partApis = parts.map((part, index) => {
    const source = inspected[index];
    if (source === undefined) throw new ApiArtifactsError([`${part.name}: missing source inspection result`]);
    return extractPart(context, part, source, problems);
  });
  return {
    slug: request.slug,
    exportNames: request.exportNames,
    parts: partApis.flatMap((entry) => (entry.part === null ? [] : [entry.part])),
    partApis,
  };
}

/** Extracts and validates the entire inventory before writing any artifact. */
export async function generateApiArtifacts(
  options: GenerateApiArtifactsOptions
): Promise<GenerateApiArtifactsResult> {
  const projectRoot = path.resolve(options.projectRoot);
  const tsconfigPath = path.resolve(projectRoot, options.tsconfigPath);
  const requests = requestsFor({ ...options, projectRoot });
  if (requests.length === 0) return { components: [], diagnostics: [] };
  const context = openLibraryProject(tsconfigPath, projectRoot);
  const problems = new ProblemLog();
  let model: readonly ComponentApi[];
  let diagnostics: readonly ApiArtifactDiagnostic[] = [];
  try {
    const generated = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const extractor = yield* ProjectExtractor;
          const described = yield* Effect.forEach(requests, (request) =>
            Effect.gen(function* () {
              const parts = componentPartRequests(context, request, problems);
              const inspected = yield* extractor.inspectComponentSources(request.entryFile, parts);
              return describeComponent(context, request, parts, inspected, problems);
            })
          );
          if (problems.problems.length > 0) {
            return yield* Effect.fail(new ApiArtifactsError(problems.problems));
          }
          const packages = options.includeExternalTypes ?? [];
          if (packages.length === 0) return { components: described, diagnostics: [] };
          const extracted: readonly ExtractionResult[] = yield* Effect.forEach(requests, (entry) =>
            extractor.extractModule(entry.entryFile, { includeExternalTypes: packages })
          );
          const enriched = enrichComponents(context, extracted, described, packages);
          const rejected = enriched.diagnostics.filter(
            (diagnostic) => !options.allowedWarningCodes?.includes(diagnostic.warning.code)
          );
          if (rejected.length > 0) {
            return yield* Effect.fail(
              new ApiArtifactsError(
                rejected.map(({ component, warning }) => `${component}: ${warning.code}: ${warning.message}`)
              )
            );
          }
          return enriched;
        }).pipe(Effect.provide(ProjectExtractor.live({ tsconfigPath, cwd: projectRoot })))
      )
    );
    model = generated.components;
    diagnostics = generated.diagnostics;
  } finally {
    context.close();
  }
  const components: GeneratedApiComponent[] = [];
  for (const [index, component] of model.entries()) {
    const request = requests[index];
    if (request === undefined) throw new Error(`Missing output for ${component.slug}`);
    const artifact: ComponentApiArtifact = {
      $generated:
        options.generatedBy ??
        "Generated from TypeScript types and JSDoc by @elmeragroup/api-artifacts. Do not edit.",
      slug: component.slug,
      parts: component.parts.map((part) => ({
        name: part.name,
        rsc: part.rsc,
        sourcePath: part.sourcePath,
        forwardedFrom: part.forwardedFrom,
        forwardedCount: part.forwardedCount,
        props: part.props.map((prop) => ({
          name: prop.name,
          origin: prop.origin,
          type: prop.type,
          shortType: prop.shortType,
          defaultValue: prop.defaultValue,
          description: prop.description,
          required: prop.required,
        })),
      })),
    };
    const text = `${JSON.stringify(artifact, null, 2)}\n`;
    components.push({
      ...artifact,
      outputFile: request.outputFile,
      text,
      changed: (await existingText(request.outputFile)) !== text,
    });
  }
  const changed = components.filter((component) => component.changed);
  if (options.mode === "check") {
    if (changed.length > 0)
      throw new ApiArtifactsDriftError(changed.map((component) => component.outputFile));
  } else {
    for (const component of changed) await writeArtifact(component.outputFile, component.text);
  }
  return { components, diagnostics };
}
