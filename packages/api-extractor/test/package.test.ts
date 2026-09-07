import { Effect, Layer } from "effect";
import type { Error as EffectError } from "effect/Effect";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";

import { ProjectExtractor as PackageProjectExtractor } from "@elmeragroup/api-extractor";
import type {
  ComponentSourceResult,
  ExtractionResult,
  ProjectExtractorService,
} from "@elmeragroup/api-extractor";
import type { BackendError, ExtractError, FileNotInProgramError } from "@elmeragroup/api-extractor";

import { CompilerBackend } from "../src/backend/service.ts";
import { openTsgoProject } from "../src/backend/ts7/project.ts";
import { projectExtractorLayer } from "../src/extractor.ts";
import { ProjectExtractor as SourceProjectExtractor } from "../src/index.ts";
import type { InternalOpenProjectOptions } from "../src/internal/project-options.ts";

const fixtureDirectory = resolve(import.meta.dirname, "fixtures/basic");
const tsconfigPath = resolve(fixtureDirectory, "tsconfig.json");
const inputPath = resolve(fixtureDirectory, "input.ts");

type ExtractModuleError = EffectError<ReturnType<ProjectExtractorService["extractModule"]>>;
type ExtractModuleEffect = ReturnType<ProjectExtractorService["extractModule"]>;
type InspectEffect = ReturnType<ProjectExtractorService["inspectComponentSources"]>;
type ExpectedExtractModuleEffect = Effect.Effect<
  ExtractionResult,
  BackendError | FileNotInProgramError | ExtractError,
  never
>;
type ExpectedInspectEffect = Effect.Effect<
  readonly ComponentSourceResult[],
  BackendError | FileNotInProgramError | ExtractError,
  never
>;

describe("package entry point", () => {
  it("keeps the public extraction effect environment-free", () => {
    expectTypeOf<ExtractModuleEffect>().toEqualTypeOf<ExpectedExtractModuleEffect>();
    expectTypeOf<InspectEffect>().toEqualTypeOf<ExpectedInspectEffect>();
  });

  it("keeps configuration failures on layer acquisition, not extraction", () => {
    expectTypeOf<ExtractModuleError>().toEqualTypeOf<BackendError | FileNotInProgramError | ExtractError>();
  });

  it("loads the compiled package entry", () => {
    expect(PackageProjectExtractor).toHaveProperty("live");
    expect(PackageProjectExtractor).not.toBe(SourceProjectExtractor);
  });

  it("keeps compiler backend services out of the package surface", async () => {
    const publicApi = await import("@elmeragroup/api-extractor");
    expect(publicApi).not.toHaveProperty("CompilerBackend");
    expect(publicApi).toHaveProperty("ProjectExtractor");
  });

  it("keeps instrumentation off the public service object", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const extractor = yield* PackageProjectExtractor;
          expect(Reflect.ownKeys(extractor)).toEqual(["extractModule", "inspectComponentSources"]);
        }).pipe(Effect.provide(PackageProjectExtractor.live({ tsconfigPath })))
      )
    );
  });

  it("does not activate timing from an extra runtime option on the public layer", async () => {
    const fileSystem = { readFile: () => undefined };
    const runtimeOptions = { tsconfigPath, cwd: fixtureDirectory, fileSystem, collectTiming: true };
    const acquisitions: InternalOpenProjectOptions[] = [];
    const backend = Layer.succeed(CompilerBackend, {
      openProject: (options) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            acquisitions.push(options);
            return openTsgoProject(options);
          }),
          (project) => Effect.sync(() => project.close())
        ),
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const extractor = yield* SourceProjectExtractor;
          yield* extractor.extractModule(inputPath);
        }).pipe(Effect.provide(projectExtractorLayer(runtimeOptions).pipe(Layer.provide(backend))))
      )
    );
    expect(acquisitions).toEqual([{ tsconfigPath, cwd: fixtureDirectory, fileSystem }]);
    expect(acquisitions[0]?.fileSystem).toBe(fileSystem);
  });

  it("keeps property options out of top-level exports and aligned provenance", async () => {
    const includeCalls: Array<{ name: string; depth: number }> = [];
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const extractor = yield* PackageProjectExtractor;
          return yield* extractor.extractModule(inputPath, {
            shouldInclude: (data) => {
              includeCalls.push(data);
              return includeCalls.length % 2 === 0;
            },
            shouldResolveObject: ({ name, propertyCount, depth, propertyDepth }) => {
              expect(name).toBeTypeOf("string");
              expect(propertyCount).toBeTypeOf("number");
              expect(depth).toBeTypeOf("number");
              expect(propertyDepth).toBeTypeOf("number");
              return false;
            },
          });
        }).pipe(Effect.provide(PackageProjectExtractor.live({ tsconfigPath })))
      )
    );

    expect(includeCalls).toEqual([]);
    expect(result.module.exports.map((entry) => entry.name)).toEqual(["greet"]);
    expect(result.provenance.map((entry) => entry.path[0])).toEqual(["greet", "greet"]);
  });

  it("does not install unused Effect packages or their release-age exclusions", () => {
    const packageManifest = readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8");
    const workspace = readFileSync(resolve(import.meta.dirname, "../../../pnpm-workspace.yaml"), "utf8");
    expect(packageManifest).not.toMatch(/@effect\/platform-node/u);
    expect(packageManifest).not.toMatch(/@effect\/vitest/u);
    expect(workspace).not.toMatch(/@effect\/platform-node/u);
    expect(workspace).not.toMatch(/@effect\/vitest/u);
    expect(workspace).not.toMatch(/@effect\/platform-node-shared/u);
  });
});
