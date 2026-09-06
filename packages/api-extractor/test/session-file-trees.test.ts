import { Effect } from "effect";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { BackendExtractionSession, BackendProject } from "../src/backend/contracts.ts";
import { openTsgoProject } from "../src/backend/ts7/project.ts";
import { ProjectExtractor } from "../src/index.ts";
import { InternalProjectExtractorTiming, timedProjectExtractorLayer } from "../src/internal/timing.ts";
import type { ExtractorOptions, ProjectFileSystem } from "../src/options.ts";

const fixtureDirectory = resolve(import.meta.dirname, "fixtures");
const basicDirectory = resolve(fixtureDirectory, "basic");
const basicTsconfigPath = resolve(basicDirectory, "tsconfig.json");
const basicInputPath = resolve(basicDirectory, "input.ts");
const aliasDirectory = resolve(fixtureDirectory, "alias-with-explicit-type-args");
const aliasTsconfigPath = resolve(fixtureDirectory, "timing-boundary-tsconfig.json");
const aliasInputPath = resolve(aliasDirectory, "input.ts");
const dtsDirectory = resolve(fixtureDirectory, "module-dts-declarations-and-reexports");
const dtsInputPath = resolve(dtsDirectory, "input.d.ts");
const starExcludedDirectory = resolve(fixtureDirectory, "star-excluded-package");
const starExcludedTsconfigPath = resolve(starExcludedDirectory, "tsconfig.json");
const starExcludedInputPath = resolve(starExcludedDirectory, "input.ts");
const mixinDirectory = resolve(fixtureDirectory, "component-external-mixin-props");
const mixinTsconfigPath = resolve(mixinDirectory, "tsconfig.json");
const mixinHostInputPath = resolve(mixinDirectory, "host.ts");

function sourceFileTotals(project: BackendProject) {
  const totals = project.getTimingInfo?.().totals;
  if (totals === undefined) throw new Error("Timing evidence is unavailable");
  return { sourceFilesFetched: totals.sourceFilesFetched, nodesFetched: totals.nodesFetched };
}

function walkExportBodies(session: BackendExtractionSession, inputPath: string): number {
  const draft = session.readModule(inputPath);
  let bodies = 0;
  for (const entry of draft.exports) {
    const facts = session.compiler.symbolFacts(entry.symbol);
    for (const declaration of facts.declarations) {
      const text = session.compiler.nodeFacts(declaration).text;
      expect(text.length).toBeGreaterThan(0);
      bodies += 1;
    }
  }
  return bodies;
}

function diskFileSystem(): ProjectFileSystem {
  return {
    directoryExists: (directoryName) => existsSync(directoryName),
    fileExists: (fileName) => existsSync(fileName),
    getAccessibleEntries: (directoryName) => {
      if (!existsSync(directoryName)) return undefined;
      const entries = readdirSync(directoryName, { withFileTypes: true });
      return {
        files: entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
        directories: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      };
    },
    readFile: (fileName) => (existsSync(fileName) ? readFileSync(fileName, "utf8") : null),
    realpath: (path) => (existsSync(path) ? realpathSync(path) : undefined),
  };
}

describe("TypeScript 7 session-owned file trees", () => {
  it("keeps the project source-file cache across sessions so a second extraction fetches nothing new", () => {
    const project = openTsgoProject({ tsconfigPath: basicTsconfigPath, collectTiming: true });
    try {
      const first = project.openExtraction();
      const firstBodies = walkExportBodies(first, basicInputPath);
      const firstAfterWalk = sourceFileTotals(project);
      expect(firstBodies).toBeGreaterThan(0);
      expect(firstAfterWalk.sourceFilesFetched).toBeGreaterThan(0);

      const firstRepeat = walkExportBodies(first, basicInputPath);
      expect(firstRepeat).toBe(firstBodies);
      expect(sourceFileTotals(project)).toEqual(firstAfterWalk);
      first.close();
      expect(() => first.readModule(basicInputPath)).toThrow(/after it closed/u);

      const beforeSecond = sourceFileTotals(project);
      const second = project.openExtraction();
      const secondBodies = walkExportBodies(second, basicInputPath);
      const secondAfterWalk = sourceFileTotals(project);
      expect(secondBodies).toBe(firstBodies);
      expect(secondAfterWalk.sourceFilesFetched).toBe(beforeSecond.sourceFilesFetched);
      second.close();
    } finally {
      project.close();
    }
  });

  it("walks a dense entry module without a source-file fetch per authored node", () => {
    const project = openTsgoProject({ tsconfigPath: aliasTsconfigPath, collectTiming: true });
    try {
      const session = project.openExtraction();
      const draft = session.readModule(aliasInputPath);
      const afterRead = sourceFileTotals(project);
      expect(afterRead.sourceFilesFetched).toBeGreaterThan(0);

      let bodies = 0;
      for (const entry of draft.exports) {
        const type = session.compiler.typeOfSymbol(entry.symbol, true);
        if (type === undefined) throw new Error(`Missing type for ${entry.name}`);
        for (const property of session.compiler.propertiesOfType(type)) {
          const facts = session.compiler.symbolFacts(property);
          for (const declaration of facts.declarations) {
            expect(session.compiler.nodeFacts(declaration).text.length).toBeGreaterThan(0);
            bodies += 1;
          }
        }
      }
      expect(bodies).toBeGreaterThan(1);
      const afterWalk = sourceFileTotals(project);
      expect(afterWalk.sourceFilesFetched).toBe(afterRead.sourceFilesFetched);
      expect(afterWalk.sourceFilesFetched).toBeLessThan(bodies);
      session.close();
    } finally {
      project.close();
    }
  });

  it("reuses a declaration file's tree while walking several of its referenced symbols", () => {
    const project = openTsgoProject({ tsconfigPath: aliasTsconfigPath, collectTiming: true });
    try {
      const session = project.openExtraction();
      const draft = session.readModule(dtsInputPath);
      const afterRead = sourceFileTotals(project);
      expect(afterRead.sourceFilesFetched).toBeGreaterThan(0);

      let bodies = 0;
      for (const entry of draft.exports) {
        const facts = session.compiler.symbolFacts(entry.symbol);
        for (const declaration of facts.declarations) {
          expect(session.compiler.nodeFacts(declaration).kind.length).toBeGreaterThan(0);
          expect(session.compiler.nodeFacts(declaration).text.length).toBeGreaterThan(0);
          bodies += 1;
        }
      }
      expect(bodies).toBeGreaterThan(1);
      const afterWalk = sourceFileTotals(project);
      expect(afterWalk.sourceFilesFetched - afterRead.sourceFilesFetched).toBeLessThan(bodies);
      const afterRepeat = sourceFileTotals(project);
      for (const entry of draft.exports) {
        const facts = session.compiler.symbolFacts(entry.symbol);
        for (const declaration of facts.declarations) {
          expect(session.compiler.nodeFacts(declaration).text.length).toBeGreaterThan(0);
        }
      }
      expect(sourceFileTotals(project).sourceFilesFetched).toBe(afterRepeat.sourceFilesFetched);
      session.close();
    } finally {
      project.close();
    }
  });

  it("extracts identically through a virtual filesystem", () => {
    const disk = openTsgoProject({ tsconfigPath: basicTsconfigPath, collectTiming: true });
    const virtual = openTsgoProject({
      tsconfigPath: basicTsconfigPath,
      collectTiming: true,
      fileSystem: diskFileSystem(),
    });
    try {
      const diskSession = disk.openExtraction();
      const virtualSession = virtual.openExtraction();
      const diskDraft = diskSession.readModule(basicInputPath);
      const virtualDraft = virtualSession.readModule(basicInputPath);
      expect(virtualDraft.name).toBe(diskDraft.name);
      expect(virtualDraft.exports.map((entry) => entry.name)).toEqual(
        diskDraft.exports.map((entry) => entry.name)
      );
      expect(sourceFileTotals(virtual).sourceFilesFetched).toBe(sourceFileTotals(disk).sourceFilesFetched);
      diskSession.close();
      virtualSession.close();
    } finally {
      disk.close();
      virtual.close();
    }
  });

  it("materializes a dependency's class declaration only when the extraction selected its package", async () => {
    const extract = (options?: ExtractorOptions) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const timing = yield* InternalProjectExtractorTiming;
            return yield* timing.extractModule(mixinHostInputPath, options);
          }).pipe(Effect.provide(timedProjectExtractorLayer({ tsconfigPath: mixinTsconfigPath })))
        )
      );
    const hostType = (result: (typeof unselected)["result"]) => {
      const entry = result.module.exports.find((candidate) => candidate.name === "HostProps");
      if (entry?.type.kind !== "object") throw new Error("Expected HostProps to be an object");
      return entry.type.properties.find((property) => property.name === "host")?.type;
    };

    // The dependency boundary asks where `RenderHost` comes from before it
    // summarizes the class. Its origin is read from the declaration's path
    // and the checker; the class body is never fetched unless the package was
    // selected, in which case the class is expanded from its declaration.
    const unselected = await extract();
    expect(hostType(unselected.result)).toMatchObject({ kind: "external", typeName: { name: "RenderHost" } });
    expect(unselected.timing.totals.sourceFilesFetched).toBe(1);

    const selected = await extract({ includeExternalTypes: ["@fixture/render"] });
    expect(hostType(selected.result)).toMatchObject({ kind: "object", properties: [{ name: "id" }] });
    expect(selected.timing.totals.sourceFilesFetched).toBe(2);
  });

  it("does not fetch an excluded export-star target until a declaration node is needed", async () => {
    const extracted = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* ProjectExtractor;
          const timing = yield* InternalProjectExtractorTiming;
          return yield* timing.extractModule(starExcludedInputPath);
        }).pipe(Effect.provide(timedProjectExtractorLayer({ tsconfigPath: starExcludedTsconfigPath })))
      )
    );
    expect(extracted.result.module.exports.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["LocalValue", "StarValue", "StarShape"])
    );
    expect(extracted.timing.totals.sourceFilesFetched).toBeGreaterThan(0);

    const project = openTsgoProject({ tsconfigPath: starExcludedTsconfigPath, collectTiming: true });
    try {
      const session = project.openExtraction();
      const draft = session.readModule(starExcludedInputPath);
      const afterRead = sourceFileTotals(project);
      expect(draft.exports.map((entry) => entry.name)).toEqual(
        expect.arrayContaining(["LocalValue", "StarValue", "StarShape"])
      );
      expect(afterRead.sourceFilesFetched).toBe(1);

      const star = draft.exports.find((entry) => entry.name === "StarValue");
      if (star === undefined) throw new Error("Missing StarValue export");
      const declaration = session.compiler.symbolFacts(star.symbol).declarations[0];
      if (declaration === undefined) throw new Error("Missing StarValue declaration");
      expect(session.compiler.declarationOwnership(declaration)).toEqual({
        kind: "dependency",
        packageName: "fixture-star-target",
      });
      expect(session.compiler.nodeKind(declaration)).toBe("variable");
      expect(sourceFileTotals(project)).toEqual(afterRead);

      expect(session.compiler.nodeFacts(declaration).text).toContain("StarValue");
      const afterText = sourceFileTotals(project);
      expect(afterText.sourceFilesFetched).toBe(afterRead.sourceFilesFetched + 1);
      expect(afterText.nodesFetched).toBeGreaterThan(afterRead.nodesFetched);
      session.close();
    } finally {
      project.close();
    }
  });
});
