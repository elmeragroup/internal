import { Effect } from "effect";
import type { Schema } from "effect";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { issue14TypecheckCommand } from "../scripts/conformance/contract.ts";
import {
  assertConformanceReportInvariants,
  assertStoredReport,
  assertStoredReportInvariants,
  assertTs7WriteReference,
  failedFixtureIndices,
  decodeIssue14ConformanceReport,
  extractFixtureResults,
  readIssue14ConformanceReport,
  summarizeFixtureRun,
  writeAdditionalTs7Evidence,
} from "../scripts/conformance/report.ts";
import {
  assertTs7DivergenceEvidence,
  differenceDigest,
  conformanceFixtureManifest,
} from "../scripts/fixture-evidence.ts";
import { createFixtureFileSystem, moduleImportsOnlyDependency } from "../scripts/fixture-filesystem.ts";
import { ExtractError, ProjectExtractor } from "../src/index.ts";
import { extractFixture } from "./support/extract.ts";
import { createTemporaryRoot, fixtureRoot } from "./support/temp-dirs.ts";

describe("Issue 14 conformance report", () => {
  it("decodes one disposition for all 116 fixtures with no failures", () => {
    const report = readIssue14ConformanceReport();
    expect(report.fixtures).toHaveLength(116);
    expect(new Set(report.fixtures.map((entry) => entry.fixture)).size).toBe(116);
    expect(report.totals).toEqual({
      fixtures: 116,
      unchanged: 97,
      reviewedDivergences: 19,
      failures: 0,
      failedFixtureIndices: [],
      unclassified: 0,
      typecheckPassed: 116,
      typecheckFailed: 0,
    });
    expect(report.status).toBe("pass");
    expect(report.fixtures.map((entry) => entry.fixture)).toEqual(
      conformanceFixtureManifest.map((entry) => entry.fixture)
    );
    expect(report.fixtures.every((entry) => entry.extraction.status === "match")).toBe(true);
    expect(report.fixtures.every((entry) => entry.typecheck.status === "pass")).toBe(true);
  });

  it("requires explicit TS7 evidence for every reviewed divergence", () => {
    const reviewed = conformanceFixtureManifest.filter((entry) => entry.disposition === "reviewed-ts7");
    expect(reviewed).toHaveLength(19);
    for (const definition of reviewed) {
      expect(() => assertTs7DivergenceEvidence(definition.fixture)).not.toThrow();
      const report = readIssue14ConformanceReport();
      const entry = report.fixtures.find((candidate) => candidate.fixture === definition.fixture);
      expect(entry?.extraction.oracleFile).toBe("output.tsgo.json");
      expect(entry?.extraction.upstreamDifferenceCount).toBeGreaterThan(0);
      expect(entry?.extraction.divergenceRecord).toBe(`${definition.fixture}/ts7-oracle.json`);
    }
  });

  it("rejects a reviewed oracle, reason, and report collapsed to the upstream oracle", () => {
    const report = readIssue14ConformanceReport();
    const reviewedIndex = report.fixtures.findIndex((fixture) => fixture.disposition === "reviewed-ts7");
    const reviewed = report.fixtures[reviewedIndex];
    if (reviewed === undefined || reviewedIndex < 0) throw new Error("Missing reviewed fixture");
    const temporaryRoot = createTemporaryRoot("api-extractor-reviewed-collapse-");
    try {
      cpSync(fixtureRoot, temporaryRoot, { recursive: true });
      const fixturePath = join(temporaryRoot, reviewed.fixture);
      const upstreamPath = join(fixturePath, "output.json");
      const selectedPath = join(fixturePath, "output.tsgo.json");
      writeFileSync(selectedPath, readFileSync(upstreamPath));
      const reasonPath = join(fixturePath, "ts7-oracle.json");
      // SAFETY: this fixture's checked-in reason artifact has this concrete shape.
      const reason = JSON.parse(readFileSync(reasonPath, "utf8")) as {
        divergence: {
          differenceCount: number;
          differenceDigest: string;
          differencePaths: string[];
        };
      };
      reason.divergence.differenceCount = 0;
      reason.divergence.differenceDigest = differenceDigest([]);
      reason.divergence.differencePaths = [];
      writeFileSync(reasonPath, JSON.stringify(reason, null, 2) + "\n");
      const selectedOracleSha256 = createHash("sha256").update(readFileSync(selectedPath)).digest("hex");
      const mutated = {
        ...report,
        fixtures: report.fixtures.map((fixture, index) =>
          index === reviewedIndex
            ? {
                ...fixture,
                extraction: {
                  ...fixture.extraction,
                  selectedOracleSha256,
                  upstreamDifferenceCount: 0,
                  upstreamDifferenceDigest: differenceDigest([]),
                },
              }
            : fixture
        ),
      };
      expect(() => assertConformanceReportInvariants(mutated, { fixtureRoot: temporaryRoot })).toThrow(
        /nonzero|divergence/u
      );
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("binds selected-oracle evidence to reviewed output.tsgo.json bytes in a disposable fixture copy", () => {
    const report = readIssue14ConformanceReport();
    const reviewed = report.fixtures.find((fixture) => fixture.disposition === "reviewed-ts7");
    if (reviewed === undefined) throw new Error("Issue 14 report has no reviewed fixture");
    const temporaryRoot = createTemporaryRoot("api-extractor-selected-oracle-");
    try {
      cpSync(fixtureRoot, temporaryRoot, { recursive: true });
      const selectedPath = join(temporaryRoot, reviewed.fixture, "output.tsgo.json");
      writeFileSync(selectedPath, readFileSync(selectedPath, "utf8") + "\n");
      expect(() => assertConformanceReportInvariants(report, { fixtureRoot: temporaryRoot })).toThrow(
        /hash/u
      );
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
  it("rejects malformed report structure before consumers can use it", () => {
    const report = readIssue14ConformanceReport();
    expect(() =>
      decodeIssue14ConformanceReport({ ...report, totals: { ...report.totals, failures: "0" } })
    ).toThrow();
    expect(() =>
      decodeIssue14ConformanceReport({ ...report, fixtures: report.fixtures.slice(0, -1) })
    ).toThrow();
  });

  it("refuses TS7 evidence writes before extraction when the pinned reference is unavailable", async () => {
    const evidencePaths = [
      "base-ui-component/output.tsgo.json",
      "base-ui-component/warnings.tsgo.json",
      "base-ui-component/ts7-oracle.json",
    ].map((path) => resolve(fixtureRoot, path));
    const before = evidencePaths.map((path) => createHash("sha256").update(readFileSync(path)).digest("hex"));
    const missingReference = resolve(fixtureRoot, "__missing-write-reference__");

    expect(() => assertTs7WriteReference(missingReference)).toThrow(/reference is unavailable/u);
    await expect(
      writeAdditionalTs7Evidence(["base-ui-component"], { referenceRoot: missingReference })
    ).rejects.toThrow(/reference is unavailable/u);

    const after = evidencePaths.map((path) => createHash("sha256").update(readFileSync(path)).digest("hex"));
    expect(after).toEqual(before);
  });

  it("executes the persisted typecheck command for direct and virtual inputs", () => {
    const definitions = conformanceFixtureManifest.filter(
      (definition) =>
        definition.fixture === "alias-with-explicit-type-args" || definition.fixture === "module-imports-only"
    );
    const packageDirectory = resolve(fixtureRoot, "../..");
    for (const definition of definitions) {
      const command = issue14TypecheckCommand(definition);
      const arguments_ = command.split(" ");
      const executable = arguments_.shift();
      if (executable === undefined) throw new Error("Missing typecheck command executable");
      const result = spawnSync(executable, arguments_, {
        cwd: packageDirectory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(result.error, definition.fixture).toBeUndefined();
      expect(result.status, definition.fixture).toBe(0);
      expect(command).toContain("--pretty false");
      // SAFETY: the runner emits the decoded TypecheckResult JSON on success.
      const output = JSON.parse(result.stdout) as { readonly command: string };
      expect(output.command).toBe(command);
    }
  });

  it("uses the public ProjectFileSystem seam for the unchanged upstream import", async () => {
    const accesses: string[] = [];
    const result = await extractFixture(
      {
        tsconfigPath: resolve(fixtureRoot, "conformance-tsconfig.json"),
        fileSystem: createFixtureFileSystem((access) => {
          if (access.virtual && access.path === moduleImportsOnlyDependency) {
            accesses.push(access.operation);
          }
        }),
      },
      resolve(fixtureRoot, "module-imports-only/input.ts")
    );
    expect(result.module.imports).toContain("../../../src/models/export");
    expect(accesses).toContain("fileExists");
    expect(accesses).toContain("readFile");
  });

  it("continues after typed failures, defects, and callback throws with exact mixed totals", async () => {
    const definitions = conformanceFixtureManifest.slice(0, 4);
    const results = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const extractor = yield* ProjectExtractor;
          return yield* extractFixtureResults(definitions, (inputPath) => {
            const index = definitions.findIndex((definition) =>
              inputPath.endsWith(`${definition.fixture}/${definition.file}`)
            );
            if (index === 0) {
              return Effect.fail(
                new ExtractError({
                  filePath: inputPath,
                  symbolStack: ["synthetic-typed-failure"],
                  message: "synthetic typed fixture failure",
                  cause: "regression",
                })
              );
            }
            if (index === 1) return Effect.die(new Error("synthetic fixture defect"));
            if (index === 2) throw new Error("synthetic callback throw");
            return extractor.extractModule(inputPath);
          });
        }).pipe(
          Effect.provide(
            ProjectExtractor.live({
              tsconfigPath: resolve(fixtureRoot, "conformance-tsconfig.json"),
              fileSystem: createFixtureFileSystem(),
            })
          )
        )
      )
    );

    expect(results).toHaveLength(4);
    expect(results.map((result) => result.status)).toEqual(["failed", "failed", "failed", "match"]);
    expect(results[0]?.error).toContain("synthetic typed fixture failure");
    expect(results[1]?.error).toContain("synthetic fixture defect");
    expect(results[2]?.error).toContain("synthetic callback throw");
    expect(
      failedFixtureIndices(
        definitions.map(() => ({ status: "pass" })),
        results
      )
    ).toEqual([0, 1, 2]);
    expect(
      summarizeFixtureRun(
        definitions,
        definitions.map(() => ({ status: "pass" })),
        results
      )
    ).toEqual({
      fixtures: 4,
      unchanged: 3,
      reviewedDivergences: 1,
      failures: 3,
      failedFixtureIndices: [0, 1, 2],
      unclassified: 0,
      typecheckPassed: 4,
      typecheckFailed: 0,
      status: "failed",
    });
  });

  it("rejects warning-detail drift even when the warning count is unchanged", () => {
    const report = readIssue14ConformanceReport();
    const first = report.fixtures[0];
    if (first === undefined) throw new Error("Issue 14 report has no fixtures");
    const mutated = {
      ...report,
      fixtures: [
        {
          ...first,
          extraction: {
            ...first.extraction,
            warningDetails: [{ drift: true }],
          },
        },
        ...report.fixtures.slice(1),
      ],
    };
    expect(() => assertConformanceReportInvariants(mutated)).toThrow(/warning evidence/u);
  });

  it("independently re-derives every persisted fixture evidence field", () => {
    const report = readIssue14ConformanceReport();
    const first = report.fixtures[0];
    const reviewedIndex = report.fixtures.findIndex((fixture) => fixture.disposition === "reviewed-ts7");
    const reviewed = report.fixtures[reviewedIndex];
    if (first === undefined || reviewed === undefined || reviewedIndex < 0) {
      throw new Error("Issue 14 mutation test requires both unchanged and reviewed fixtures");
    }
    const mutate = (
      index: number,
      update: (fixture: (typeof report.fixtures)[number]) => object
    ): Schema.Json => ({
      ...report,
      fixtures: report.fixtures.map((fixture, candidate) =>
        candidate === index ? { ...fixture, ...update(fixture) } : fixture
      ),
    });
    const mutations: readonly [string, Schema.Json][] = [
      ["input hash", mutate(0, (_fixture) => ({ inputSha256: "0".repeat(64) }))],
      ["upstream hash", mutate(0, (_fixture) => ({ upstreamOracleSha256: "0".repeat(64) }))],
      ["fixture name", mutate(0, (fixture) => ({ fixture: fixture.fixture + "-drift" }))],
      ["input path", mutate(0, (_fixture) => ({ input: "other.ts" }))],
      ["disposition", mutate(0, (_fixture) => ({ disposition: "reviewed-ts7" }))],
      [
        "typecheck command",
        mutate(0, (fixture) => ({ typecheck: { ...fixture.typecheck, command: "drift" } })),
      ],
      [
        "typecheck strategy",
        mutate(0, (fixture) => ({
          typecheck: { ...fixture.typecheck, strategy: "virtual-upstream-dependency" },
        })),
      ],
      [
        "selected oracle",
        mutate(reviewedIndex, (fixture) => ({
          extraction: { ...fixture.extraction, oracleFile: "output.json" },
        })),
      ],
      [
        "selected oracle hash",
        mutate(reviewedIndex, (fixture) => ({
          extraction: { ...fixture.extraction, selectedOracleSha256: "0".repeat(64) },
        })),
      ],
      [
        "extraction status",
        mutate(0, (fixture) => ({ extraction: { ...fixture.extraction, status: "failed" } })),
      ],
      [
        "extraction error",
        mutate(0, (fixture) => ({ extraction: { ...fixture.extraction, error: "drift" } })),
      ],
      [
        "difference count",
        mutate(0, (fixture) => ({
          extraction: { ...fixture.extraction, differenceCount: 1 },
        })),
      ],
      [
        "difference digest",
        mutate(0, (fixture) => ({
          extraction: { ...fixture.extraction, differenceDigest: "drift" },
        })),
      ],
      [
        "upstream difference count",
        mutate(reviewedIndex, (fixture) => ({
          extraction: {
            ...fixture.extraction,
            upstreamDifferenceCount: fixture.extraction.upstreamDifferenceCount + 1,
          },
        })),
      ],
      [
        "unchanged upstream difference count",
        mutate(0, (fixture) => ({
          extraction: { ...fixture.extraction, upstreamDifferenceCount: 1 },
        })),
      ],
      [
        "upstream difference digest",
        mutate(reviewedIndex, (fixture) => ({
          extraction: { ...fixture.extraction, upstreamDifferenceDigest: "drift" },
        })),
      ],
      [
        "divergence record",
        mutate(reviewedIndex, (fixture) => ({
          extraction: { ...fixture.extraction, divergenceRecord: "wrong/ts7-oracle.json" },
        })),
      ],
      [
        "warning oracle path",
        mutate(0, (fixture) => ({
          extraction: { ...fixture.extraction, warningOracle: "wrong/warnings.tsgo.json" },
        })),
      ],
    ];
    for (const [label, mutated] of mutations) {
      expect(() => assertStoredReportInvariants(mutated), label).toThrow();
    }
  });

  it("requires exact persisted command and verified reference metadata", () => {
    const report = readIssue14ConformanceReport();
    expect(() =>
      assertStoredReportInvariants({
        ...report,
        command: "node scripts/other.ts --check",
      })
    ).toThrow(/command/u);
    expect(() => assertStoredReportInvariants({ ...report, status: "failed" })).toThrow(/status|green/u);
    expect(() =>
      assertStoredReportInvariants({
        ...report,
        referenceCheck: { ...report.referenceCheck, fixtureCount: 115 },
      })
    ).toThrow(/reference|path/u);
    expect(() =>
      assertStoredReportInvariants({
        ...report,
        referenceCheck: {
          ...report.referenceCheck,
          status: "skipped",
          fixtureCount: 0,
          comparedFiles: 0,
          pathUniverse: { ...report.referenceCheck.pathUniverse, count: 0, sha256: "not-verified" },
        },
      })
    ).toThrow(/verified|skipped/u);
  });

  it("accepts a skipped current optional audit without downgrading verified stored evidence", () => {
    const stored = readIssue14ConformanceReport();
    const measured = {
      ...stored,
      referenceCheck: {
        ...stored.referenceCheck,
        status: "skipped" as const,
        fixtureCount: 0,
        comparedFiles: 0,
        pathUniverse: { ...stored.referenceCheck.pathUniverse, count: 0, sha256: "not-verified" },
      },
    };
    expect(() => assertStoredReport(stored, measured)).not.toThrow();
  });
});
