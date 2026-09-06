import { Cause, Effect, Exit, Schema } from "effect";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { ExtractWarningSchema, ProjectExtractor } from "../../src/index.ts";
import type { ExtractWarning } from "../../src/index.ts";
import { definedFields } from "../../src/optional-fields.ts";
import { writeArtifactBatchOrThrow } from "../artifact-batch-writer.ts";
import type { ArtifactBatchItem } from "../artifact-batch-writer.ts";
import { runIfMain } from "../cli.ts";
import { fixtureEvidenceCatalog } from "../fixture-catalog.ts";
import {
  assertTs7DivergenceEvidence,
  canonicalDifferencePaths,
  differenceDigest,
  conformanceFixtureManifest,
  pinnedTypeScript7Compiler,
  decodeJson,
  normalizeWarnings,
  packageVersion,
  posixRelative,
  sha256File,
} from "../fixture-evidence.ts";
import type { ConformanceFixture } from "../fixture-evidence.ts";
import { createFixtureFileSystem } from "../fixture-filesystem.ts";
import { deriveWarningEvidencePlan } from "../fixture-plans.ts";
import { auditPinnedReference, pinnedFixturePathUniverse, pinnedUpstream } from "../reference.ts";
import { issue14ConformanceCommand, issue14SelectedOracleFile } from "./contract.ts";
import {
  assertConformanceDecoded,
  assertReferenceEvidence,
  assertStoredReport,
  assertStoredReportDecoded,
  manifestSha256,
  summarizeFixtureRun,
} from "./invariants.ts";
import type { ConformanceInvariantOptions } from "./invariants.ts";
import { typecheckFixture } from "./typecheck.ts";
import type { TypecheckResult } from "./typecheck.ts";

const packageDirectory = resolve(import.meta.dirname, "../..");
const fixtureDirectory = join(packageDirectory, "test/fixtures");
const configPath = join(fixtureDirectory, "conformance-tsconfig.json");
const reportPath = join(fixtureDirectory, "conformance.json");
const upstreamCommit = pinnedUpstream.commit;
const expectedFixtureCount = 116;

async function writeEvidenceBatch(artifacts: readonly ArtifactBatchItem[]): Promise<void> {
  await writeArtifactBatchOrThrow({ outputRoot: fixtureDirectory, artifacts }, "Issue 14 evidence write");
}

export { issue14ConformanceCommand } from "./contract.ts";
export { assertStoredReport, summarizeFixtureRun } from "./invariants.ts";

type AdditionalTs7Evidence = {
  readonly code: string;
  readonly genus: string;
  readonly reason: string;
  readonly differencePaths: readonly string[];
  readonly differenceDigest: string;
};

const additionalTs7Evidence = new Map<string, AdditionalTs7Evidence>(
  Object.entries({
    "generic-callback-typeparam-vs-typename-collision": {
      code: "TS7_CONSTRAINT_TYPEPARAM_RENDERING",
      genus: "constraint-rendering",
      reason:
        "TypeScript 7 renders the self-referential `{ self: T }` constraint through the type-parameter node, while the pinned TypeScript 6 oracle observes the intermediate concrete interface object named `T`. The eight changed leaves are limited to the Colliding callback's parameter and return constraints; the AlphaEquiv callback and the rest of the generic structure are unchanged. This is a checker rendering difference under substitution, not a canonicalization or ownership policy decision.",
      differencePaths: [
        "/exports/0/type/types/0/callSignatures/0/parameters/0/type/constraint/properties/0/type/kind",
        "/exports/0/type/types/0/callSignatures/0/parameters/0/type/constraint/properties/0/type/name",
        "/exports/0/type/types/0/callSignatures/0/parameters/0/type/constraint/properties/0/type/properties/@length",
        "/exports/0/type/types/0/callSignatures/0/parameters/0/type/constraint/properties/0/type/typeName/name",
        "/exports/0/type/types/0/callSignatures/0/returnValueType/constraint/properties/0/type/kind",
        "/exports/0/type/types/0/callSignatures/0/returnValueType/constraint/properties/0/type/name",
        "/exports/0/type/types/0/callSignatures/0/returnValueType/constraint/properties/0/type/properties/@length",
        "/exports/0/type/types/0/callSignatures/0/returnValueType/constraint/properties/0/type/typeName/name",
      ],
      differenceDigest: "2a1f6afcbe382547bf4157002fc0dbed0555b74ce9e0b4d5d976e1838c9a27a0",
    },
    "interface-extends-basic-resolution": {
      code: "TS7_INTERFACE_MEMBER_ENUMERATION_AND_FALLBACK",
      genus: "checker-member-order-and-unsupported-any-fallback",
      reason:
        "TypeScript 7 enumerates inherited interface members in declaration order where the pinned TypeScript 6 checker reports the instantiated order, and its native symbol graph exposes the exported namespace value `Dialog` as an unresolved `any`. The nine changed leaves are limited to the three inherited property orders, the `Dialog` fallback, and the corresponding `Dialog.Props` surface. Heritage names and resolved names remain intact, so this is compiler-view evidence rather than a resolver policy change.",
      differencePaths: [
        "/exports/0/type/properties/0/name",
        "/exports/0/type/properties/1/name",
        "/exports/1/type/properties/0/name",
        "/exports/1/type/properties/1/name",
        "/exports/1/type/properties/1/type/intrinsic",
        "/exports/1/type/properties/2/name",
        "/exports/1/type/properties/2/type/intrinsic",
        "/exports/2/type/properties/0/name",
        "/exports/2/type/properties/1/name",
      ],
      differenceDigest: "51622464ef9317fc11c2b8f3f0e74dd4c0be3348adbfe9950abd8ba468cce775",
    },
    "symbol-double-underscore-name-preservation": {
      code: "TS7_DOUBLE_UNDERSCORE_SYMBOL_RESOLUTION",
      genus: "reserved-symbol-name-resolution",
      reason:
        "TypeScript 7's native checker does not materialize the exported object symbol whose name begins with `__` in the same way as the pinned TypeScript 6 checker. Function parameter and return types therefore retain an anonymous object shape, while the direct `__Named` export falls through the structured unsupported-type warning to `any`. The nine changed leaves and one warning are confined to that compiler symbol-resolution behavior; the authored input and upstream oracle remain unchanged.",
      differencePaths: [
        "/exports/0/type/callSignatures/0/parameters/0/type/typeName/name",
        "/exports/0/type/callSignatures/0/returnValueType/typeName/name",
        "/exports/1/type/intrinsic",
        "/exports/1/type/kind",
        "/exports/1/type/properties/0/name",
        "/exports/1/type/properties/0/optional",
        "/exports/1/type/properties/0/type/intrinsic",
        "/exports/1/type/properties/0/type/kind",
        "/exports/1/type/typeName/name",
      ],
      differenceDigest: "3a23a9015a8c1f270c80389b949813b3873474a0a645016f91004ab98e1b4303",
    },
  } satisfies Record<string, AdditionalTs7Evidence>)
);

const EvidenceTextSchema = Schema.String.check(Schema.isPattern(/\S/u));
const Sha256Schema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const DispositionSchema = Schema.Literals(["unchanged", "reviewed-ts7"] as const);
const FixtureTypecheckSchema = Schema.Struct({
  status: Schema.Literals(["pass", "failed"] as const),
  strategy: Schema.Literals(["direct-input", "virtual-upstream-dependency"] as const),
  command: EvidenceTextSchema,
  diagnosticCount: Schema.Natural,
  diagnostics: Schema.Array(Schema.String),
});
const FixtureExtractionSchema = Schema.Struct({
  status: Schema.Literals(["match", "failed"] as const),
  oracleFile: Schema.Literals(["output.json", "output.tsgo.json"] as const),
  selectedOracleSha256: Sha256Schema,
  differenceCount: Schema.Natural,
  differenceDigest: EvidenceTextSchema,
  /** Difference evidence is always measured against immutable output.json. */
  upstreamDifferenceCount: Schema.Natural,
  upstreamDifferenceDigest: EvidenceTextSchema,
  warningCount: Schema.Natural,
  warningDetails: Schema.Array(Schema.Json),
  warningDigest: EvidenceTextSchema,
  warningOracle: Schema.optionalKey(Schema.String),
  divergenceRecord: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
const FixtureReportSchema = Schema.Struct({
  fixture: EvidenceTextSchema,
  input: EvidenceTextSchema,
  disposition: DispositionSchema,
  inputSha256: Schema.String,
  upstreamOracleSha256: Schema.String,
  typecheck: FixtureTypecheckSchema,
  extraction: FixtureExtractionSchema,
});
const FixtureListSchema = Schema.Array(FixtureReportSchema).check(
  Schema.makeFilter(
    (fixtures) => fixtures.length === expectedFixtureCount || "exactly 116 fixture records are required"
  )
);

const ReferenceCheckSchema = Schema.Struct({
  mode: Schema.Literals(["optional", "required"] as const),
  status: Schema.Literals(["verified", "skipped"] as const),
  repository: EvidenceTextSchema,
  commit: Schema.Literal(upstreamCommit),
  fixtureCount: Schema.Natural,
  comparedFiles: Schema.Natural,
  pathUniverse: Schema.Struct({
    count: Schema.Natural,
    sha256: EvidenceTextSchema,
    command: Schema.Literal(pinnedFixturePathUniverse.command),
  }),
  command: EvidenceTextSchema,
});

export const Issue14ConformanceReportSchema = Schema.Struct({
  issue: Schema.Literal("14-full-conformance"),
  command: Schema.Literal(issue14ConformanceCommand),
  upstream: Schema.Struct({
    repository: Schema.Literal(pinnedUpstream.repository),
    commit: Schema.Literal(upstreamCommit),
    fixtureCount: Schema.Literal(expectedFixtureCount),
    originalOracle: Schema.Literal("output.json"),
  }),
  manifestSha256: EvidenceTextSchema,
  totals: Schema.Struct({
    fixtures: Schema.Literal(expectedFixtureCount),
    unchanged: Schema.Natural,
    reviewedDivergences: Schema.Natural,
    failures: Schema.Natural,
    failedFixtureIndices: Schema.Array(Schema.Natural),
    unclassified: Schema.Natural,
    typecheckPassed: Schema.Natural,
    typecheckFailed: Schema.Natural,
  }),
  fixtures: FixtureListSchema,
  referenceCheck: ReferenceCheckSchema,
  status: Schema.Literals(["pass", "failed"] as const),
});

export type Issue14ConformanceReport = Schema.Schema.Type<typeof Issue14ConformanceReportSchema>;

type ExtractionResult = {
  readonly status: "match" | "failed";
  readonly oracleFile: "output.json" | "output.tsgo.json";
  readonly selectedOracleSha256: string;
  readonly differenceCount: number;
  readonly differenceDigest: string;
  readonly upstreamDifferenceCount: number;
  readonly upstreamDifferenceDigest: string;
  readonly warningCount: number;
  readonly warningDetails: readonly Schema.Json[];
  readonly warningDigest: string;
  readonly warningOracle?: string;
  readonly divergenceRecord?: string;
  readonly error?: string;
};

/** The small value returned by the public `extractModule` seam. */
export type FixtureExtractionValue = {
  readonly module: unknown;
  readonly warnings: readonly ExtractWarning[];
};

/**
 * Testable adapter for the public extraction seam.  Keeping this callback
 * narrow lets the conformance loop inject one typed failure without replacing
 * the real ProjectExtractor service or its project lifecycle.
 */
export type FixtureExtraction = (inputPath: string) => Effect.Effect<FixtureExtractionValue, unknown>;

function assertCompilerIdentity(): void {
  const actual = "typescript@" + packageVersion("typescript");
  if (actual !== pinnedTypeScript7Compiler) {
    throw new Error(`Issue 14 conformance requires ${pinnedTypeScript7Compiler}; found ${actual}.`);
  }
}

function relativeFixturePath(path: string): string {
  return posixRelative(fixtureDirectory, path);
}

function existingJsonIndent(path: string): string | number {
  const indentation = /\n([\t ]+)\S/u.exec(readFileSync(path, "utf8"))?.[1];
  return indentation ?? 2;
}

function warningOraclePath(fixture: string): string | undefined {
  const path = join(fixtureDirectory, fixture, "warnings.tsgo.json");
  return existsSync(path) ? path : undefined;
}

type WarningEvidence = {
  readonly warningCount: number;
  readonly warningDetails: readonly Schema.Json[];
  readonly warningDigest: string;
};

function warningEvidence(warnings: readonly ExtractWarning[]): WarningEvidence {
  const warningDetails = Schema.decodeUnknownSync(Schema.Array(Schema.Json))(
    JSON.parse(JSON.stringify(normalizeWarnings(warnings)))
  );
  const warningDigest = createHash("sha256").update(JSON.stringify(warningDetails), "utf8").digest("hex");
  return { warningCount: warningDetails.length, warningDetails, warningDigest } satisfies WarningEvidence;
}

function failedExtraction(definition: ConformanceFixture, error: string): ExtractionResult {
  const oracleFile = issue14SelectedOracleFile(definition);
  const selectedOraclePath = join(fixtureDirectory, definition.fixture, oracleFile);
  return {
    status: "failed",
    oracleFile,
    selectedOracleSha256: sha256File(selectedOraclePath),
    differenceCount: 0,
    differenceDigest: differenceDigest([]),
    upstreamDifferenceCount: 0,
    upstreamDifferenceDigest: differenceDigest([]),
    ...warningEvidence([]),
    ...definedFields({
      divergenceRecord:
        definition.disposition === "reviewed-ts7"
          ? relativeFixturePath(join(fixtureDirectory, definition.fixture, "ts7-oracle.json"))
          : undefined,
    }),
    error,
  };
}

function compareFixtureExtraction(
  definition: ConformanceFixture,
  result: FixtureExtractionValue,
  warningOverrides: ReadonlyMap<string, readonly Schema.Json[]> = new Map()
): ExtractionResult {
  const oracleFile = issue14SelectedOracleFile(definition);
  const selectedOraclePath = join(fixtureDirectory, definition.fixture, oracleFile);
  try {
    const actual = Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(result.module)));
    const upstream = decodeJson(join(fixtureDirectory, definition.fixture, "output.json"));
    const upstreamDifferences = canonicalDifferencePaths(upstream, actual);
    const expected = decodeJson(join(fixtureDirectory, definition.fixture, oracleFile));
    const differences = canonicalDifferencePaths(actual, expected);
    const warningPath = warningOraclePath(definition.fixture);
    const expectedWarnings =
      warningOverrides.get(definition.fixture) ??
      Schema.decodeUnknownSync(Schema.Array(Schema.Json))(
        warningPath === undefined ? [] : decodeJson(warningPath)
      );
    const actualWarnings = Schema.decodeUnknownSync(Schema.Array(Schema.Json))(
      JSON.parse(JSON.stringify(normalizeWarnings(result.warnings)))
    );
    if (JSON.stringify(actualWarnings) !== JSON.stringify(expectedWarnings)) {
      return {
        status: "failed",
        oracleFile,
        selectedOracleSha256: sha256File(selectedOraclePath),
        differenceCount: differences.length,
        differenceDigest: differenceDigest(differences),
        upstreamDifferenceCount: upstreamDifferences.length,
        upstreamDifferenceDigest: differenceDigest(upstreamDifferences),
        ...warningEvidence(result.warnings),
        ...definedFields({
          warningOracle: warningPath === undefined ? undefined : relativeFixturePath(warningPath),
          divergenceRecord:
            definition.disposition === "reviewed-ts7"
              ? relativeFixturePath(join(fixtureDirectory, definition.fixture, "ts7-oracle.json"))
              : undefined,
        }),
        error: warningPath === undefined ? "unexpected warning without oracle" : "warning oracle mismatch",
      };
    }
    if (definition.disposition === "reviewed-ts7") assertTs7DivergenceEvidence(definition.fixture);
    return {
      status: differences.length === 0 ? "match" : "failed",
      oracleFile,
      selectedOracleSha256: sha256File(selectedOraclePath),
      differenceCount: differences.length,
      differenceDigest: differenceDigest(differences),
      upstreamDifferenceCount: upstreamDifferences.length,
      upstreamDifferenceDigest: differenceDigest(upstreamDifferences),
      ...warningEvidence(result.warnings),
      ...definedFields({
        warningOracle: warningPath === undefined ? undefined : relativeFixturePath(warningPath),
        divergenceRecord:
          definition.disposition === "reviewed-ts7"
            ? relativeFixturePath(join(fixtureDirectory, definition.fixture, "ts7-oracle.json"))
            : undefined,
        error: differences.length === 0 ? undefined : "extraction output does not match selected oracle",
      }),
    };
  } catch (error) {
    return failedExtraction(definition, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Run the complete per-fixture loop while turning both typed Effect failures
 * and defects/throws into records.  `Effect.exit` is deliberate here: a
 * JavaScript try/catch around `yield*` cannot observe a typed Effect failure,
 * and one bad fixture must not prevent later fixtures from running.
 */
export function extractFixtureResults(
  definitions: readonly ConformanceFixture[],
  extract: FixtureExtraction,
  warningOverrides: ReadonlyMap<string, readonly Schema.Json[]> = new Map()
): Effect.Effect<readonly ExtractionResult[], never> {
  return Effect.gen(function* () {
    const results: ExtractionResult[] = [];
    for (const definition of definitions) {
      const inputPath = join(fixtureDirectory, definition.fixture, definition.file);
      const exit = yield* Effect.exit(Effect.sync(() => extract(inputPath)).pipe(Effect.flatten));
      if (Exit.isFailure(exit)) {
        results.push(failedExtraction(definition, Cause.pretty(exit.cause) || "fixture extraction failed"));
        continue;
      }
      results.push(compareFixtureExtraction(definition, exit.value, warningOverrides));
    }
    return results;
  });
}

function extractAll(
  warningOverrides: ReadonlyMap<string, readonly Schema.Json[]> = new Map()
): Promise<readonly ExtractionResult[]> {
  // Keep the actual conformance path on the public seam: the fixture FS is
  // where module-imports-only receives its upstream dependency in memory.
  const effect = Effect.gen(function* () {
    const extractor = yield* ProjectExtractor;
    const extract: FixtureExtraction = (inputPath) => extractor.extractModule(inputPath);
    return yield* extractFixtureResults(conformanceFixtureManifest, extract, warningOverrides);
  }).pipe(
    Effect.provide(
      ProjectExtractor.live({
        tsconfigPath: configPath,
        fileSystem: createFixtureFileSystem(),
      })
    )
  );
  return Effect.runPromise(Effect.scoped(effect));
}

function assertManifest(requireTs7Evidence = true): void {
  const names = conformanceFixtureManifest.map((entry) => entry.fixture);
  if (names.length !== expectedFixtureCount) {
    throw new Error(`Issue 14 manifest must contain exactly ${expectedFixtureCount} fixtures.`);
  }
  const sortedNames = [...names].sort();
  if (new Set(names).size !== names.length || names.some((name, index) => name !== sortedNames[index])) {
    throw new Error("Issue 14 manifest names must be sorted and unique.");
  }
  const discoveredNames = readdirSync(fixtureDirectory, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isDirectory() || !existsSync(join(fixtureDirectory, entry.name, "output.json")))
        return false;
      const record = fixtureEvidenceCatalog.find((candidate) => candidate.id === entry.name);
      // Local generated oracles keep `output.json` as their regression seam
      // without joining the pinned Issue 14 set.
      return record?.conformance !== false;
    })
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(discoveredNames) !== JSON.stringify(sortedNames)) {
    throw new Error(
      `Issue 14 fixture discovery must yield exactly the manifest set (${expectedFixtureCount}); ` +
        `discovered ${discoveredNames.length}.`
    );
  }
  for (const definition of conformanceFixtureManifest) {
    const directory = join(fixtureDirectory, definition.fixture);
    if (!existsSync(join(directory, definition.file)) || !existsSync(join(directory, "output.json"))) {
      throw new Error(`Incomplete pinned fixture: ${definition.fixture}`);
    }
    if (definition.disposition === "reviewed-ts7" && requireTs7Evidence) {
      if (
        !existsSync(join(directory, "output.tsgo.json")) ||
        !existsSync(join(directory, "ts7-oracle.json"))
      ) {
        throw new Error(`Reviewed fixture is missing TS7 evidence: ${definition.fixture}`);
      }
    }
  }
}

export function assertTs7WriteReference(
  referenceRoot = pinnedUpstream.root
): ReturnType<typeof auditPinnedReference> {
  const audit = auditPinnedReference("required", { referenceRoot });
  if (audit.status !== "verified") {
    throw new Error("--write-ts7 requires a verified pinned upstream reference before extraction.");
  }
  return audit;
}

export async function writeAdditionalTs7Evidence(
  names: readonly string[],
  options: { readonly referenceRoot?: string } = {}
): Promise<void> {
  assertTs7WriteReference(options.referenceRoot);
  if (names.length === 0) throw new Error("--write-ts7 requires one or more explicit fixture names.");
  assertManifest(false);
  const definitions = names.map((name) => {
    const definition = conformanceFixtureManifest.find((entry) => entry.fixture === name);
    if (definition?.disposition !== "reviewed-ts7") {
      throw new Error(`--write-ts7 accepts only reviewed Issue 14 fixtures: ${name}`);
    }
    const evidence = additionalTs7Evidence.get(name);
    if (evidence === undefined) {
      throw new Error(`No reviewed TS7 reason is available for ${name}; refusing implicit regeneration.`);
    }
    return { definition, evidence };
  });
  const effect = Effect.gen(function* () {
    const extractor = yield* ProjectExtractor;
    const results = new Map<
      string,
      { readonly module: unknown; readonly warnings: readonly ExtractWarning[] }
    >();
    for (const { definition } of definitions) {
      const inputPath = join(fixtureDirectory, definition.fixture, definition.file);
      const result = yield* extractor.extractModule(inputPath);
      results.set(definition.fixture, { module: result.module, warnings: result.warnings });
    }
    return results;
  }).pipe(
    Effect.provide(
      ProjectExtractor.live({
        tsconfigPath: configPath,
        fileSystem: createFixtureFileSystem(),
      })
    )
  );
  const results = await Effect.runPromise(Effect.scoped(effect));
  const generatedFiles: ArtifactBatchItem[] = [];
  for (const { definition, evidence } of definitions) {
    const result = results.get(definition.fixture);
    if (result === undefined) throw new Error(`No extraction result for ${definition.fixture}`);
    const upstreamPath = join(fixtureDirectory, definition.fixture, "output.json");
    const module = Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(result.module)));
    const differences = canonicalDifferencePaths(decodeJson(upstreamPath), module);
    if (
      JSON.stringify(differences) !== JSON.stringify(evidence.differencePaths) ||
      differenceDigest(differences) !== evidence.differenceDigest
    ) {
      throw new Error(`The reviewed difference evidence is stale for ${definition.fixture}.`);
    }
    generatedFiles.push(
      {
        destination: join(definition.fixture, "output.tsgo.json"),
        content: `${JSON.stringify(module, null, 2)}\n`,
        evidence: "reviewed",
      },
      {
        destination: join(definition.fixture, "warnings.tsgo.json"),
        content: `${JSON.stringify(normalizeWarnings(result.warnings), null, 2)}\n`,
        evidence: "reviewed",
      },
      {
        destination: join(definition.fixture, "ts7-oracle.json"),
        content: `${JSON.stringify(
          {
            fixture: definition.fixture,
            compiler: "typescript@" + packageVersion("typescript"),
            sourceOracle: "output.json",
            comparison: "exact",
            divergence: {
              code: evidence.code,
              genus: evidence.genus,
              reason: evidence.reason,
              upstreamPreserved: true,
              differenceCount: differences.length,
              differenceDigest: differenceDigest(differences),
              differencePaths: differences,
            },
          },
          null,
          2
        )}\n`,
        evidence: "reviewed",
      }
    );
  }
  await writeEvidenceBatch(generatedFiles);
}

type WarningEvidenceSelection = {
  readonly definition: ConformanceFixture;
  readonly oracleFile: "warnings.tsgo.json";
  readonly codes: readonly string[];
};

function warningStructure(warnings: readonly ExtractWarning[]): string {
  return JSON.stringify(
    warnings.map((warning) =>
      Object.fromEntries(Object.entries(warning).filter(([field]) => field !== "message"))
    )
  );
}

function selectWarningEvidence(names: readonly string[]): readonly WarningEvidenceSelection[] {
  const plan = deriveWarningEvidencePlan(fixtureEvidenceCatalog);
  const selectedNames = names.length === 0 ? plan.map((entry) => entry.fixture) : names;
  if (new Set(selectedNames).size !== selectedNames.length) {
    throw new Error("--write-warnings accepts each fixture name at most once.");
  }
  return selectedNames.map((name) => {
    const warning = plan.find((entry) => entry.fixture === name);
    const definition = conformanceFixtureManifest.find((entry) => entry.fixture === name);
    if (warning === undefined || definition === undefined) {
      throw new Error(`--write-warnings accepts only cataloged warning fixtures: ${name}`);
    }
    return { definition, oracleFile: warning.oracleFile, codes: warning.codes };
  });
}

async function extractWarningEvidence(
  selections: readonly WarningEvidenceSelection[]
): Promise<ReadonlyMap<string, readonly Schema.Json[]>> {
  const effect = Effect.gen(function* () {
    const extractor = yield* ProjectExtractor;
    const warnings = new Map<string, readonly ExtractWarning[]>();
    for (const { definition } of selections) {
      const inputPath = join(fixtureDirectory, definition.fixture, definition.file);
      const result = yield* extractor.extractModule(inputPath);
      warnings.set(definition.fixture, result.warnings);
    }
    return warnings;
  }).pipe(
    Effect.provide(
      ProjectExtractor.live({
        tsconfigPath: configPath,
        fileSystem: createFixtureFileSystem(),
      })
    )
  );
  const extracted = await Effect.runPromise(Effect.scoped(effect));
  return new Map(
    selections.map(({ definition, codes }) => {
      const warnings = extracted.get(definition.fixture);
      if (warnings === undefined) throw new Error(`No warning result for ${definition.fixture}.`);
      const actualCodes = warnings.map((warning) => warning.code);
      if (JSON.stringify(actualCodes) !== JSON.stringify(codes)) {
        throw new Error(
          `Warning identities changed for ${definition.fixture}; expected ${JSON.stringify(codes)}, found ${JSON.stringify(actualCodes)}.`
        );
      }
      const normalizedWarnings = normalizeWarnings(warnings);
      const existingWarnings = Schema.decodeUnknownSync(Schema.Array(ExtractWarningSchema))(
        decodeJson(join(fixtureDirectory, definition.fixture, "warnings.tsgo.json"))
      );
      if (warningStructure(normalizedWarnings) !== warningStructure(existingWarnings)) {
        throw new Error(
          `Warning structure changed for ${definition.fixture}; --write-warnings may update prose only.`
        );
      }
      const normalized = Schema.decodeUnknownSync(Schema.Array(Schema.Json))(
        JSON.parse(JSON.stringify(normalizedWarnings))
      );
      return [definition.fixture, normalized] as const;
    })
  );
}

/** Refresh only cataloged warning oracles and the report that records their reviewed bytes. */
export async function refreshWarningEvidence(
  names: readonly string[] = [],
  options: { readonly referenceRoot?: string } = {}
): Promise<void> {
  assertManifest();
  const selections = selectWarningEvidence(names);
  const referenceCheck = auditPinnedReference("optional", { referenceRoot: options.referenceRoot });
  if (referenceCheck.status !== "verified") {
    throw new Error("--write-warnings requires a verified pinned upstream reference before extraction.");
  }
  const warningOverrides = await extractWarningEvidence(selections);
  const typechecks = conformanceFixtureManifest.map(typecheckFixture);
  const extractions = await extractAll(warningOverrides);
  const measured = reportFrom(typechecks, extractions, referenceCheck);
  assertReferenceEvidence(measured.referenceCheck, true);
  const artifacts: ArtifactBatchItem[] = selections.map(({ definition, oracleFile }) => {
    const warnings = warningOverrides.get(definition.fixture);
    if (warnings === undefined) throw new Error(`No warning evidence for ${definition.fixture}.`);
    return {
      destination: join(definition.fixture, oracleFile),
      content: `${JSON.stringify(
        warnings,
        null,
        existingJsonIndent(join(fixtureDirectory, definition.fixture, oracleFile))
      )}\n`,
      evidence: "reviewed",
    };
  });
  artifacts.push({
    destination: "conformance.json",
    content: `${JSON.stringify(measured, null, 2)}\n`,
    evidence: "generated",
  });
  await writeEvidenceBatch(artifacts);
}

function reportFrom(
  typechecks: readonly TypecheckResult[],
  extractions: readonly ExtractionResult[],
  referenceCheck: ReturnType<typeof auditPinnedReference>
): Issue14ConformanceReport {
  const fixtures = conformanceFixtureManifest.map((definition, index) => {
    const inputPath = join(fixtureDirectory, definition.fixture, definition.file);
    const typecheck = typechecks[index];
    const extraction = extractions[index];
    if (typecheck === undefined || extraction === undefined) {
      throw new Error(`Issue 14 evidence is missing at fixture index ${index}.`);
    }
    return {
      fixture: definition.fixture,
      input: definition.file,
      disposition: definition.disposition,
      inputSha256: sha256File(inputPath),
      upstreamOracleSha256: sha256File(join(fixtureDirectory, definition.fixture, "output.json")),
      typecheck,
      extraction,
    };
  });
  const summary = summarizeFixtureRun(conformanceFixtureManifest, typechecks, extractions);
  return {
    issue: "14-full-conformance",
    command: issue14ConformanceCommand,
    upstream: {
      repository: "michaldudak/typescript-api-extractor",
      commit: upstreamCommit,
      fixtureCount: expectedFixtureCount,
      originalOracle: "output.json",
    },
    manifestSha256: manifestSha256(),
    totals: {
      // assertManifest() established the exact manifest cardinality before
      // this report is built; keep the schema's literal 116 guard intact.
      // SAFETY: assertManifest() and the fixture construction above enforce the 116-record contract.
      fixtures: fixtures.length as typeof expectedFixtureCount,
      unchanged: summary.unchanged,
      reviewedDivergences: summary.reviewedDivergences,
      failures: summary.failures,
      failedFixtureIndices: summary.failedFixtureIndices,
      unclassified: summary.unclassified,
      typecheckPassed: summary.typecheckPassed,
      typecheckFailed: summary.typecheckFailed,
    },
    fixtures,
    referenceCheck,
    status: summary.status,
  };
}

/** Return the union of indices with an independent typecheck or extraction failure. */
export function failedFixtureIndices(
  typechecks: readonly { readonly status: string }[],
  extractions: readonly { readonly status: string }[]
): readonly number[] {
  const failed = new Set<number>();
  for (let index = 0; index < Math.max(typechecks.length, extractions.length); index += 1) {
    if (typechecks[index]?.status !== "pass" || extractions[index]?.status !== "match") {
      failed.add(index);
    }
  }
  return [...failed].sort((left, right) => left - right);
}

export function decodeIssue14ConformanceReport(value: Schema.Json): Issue14ConformanceReport {
  return Schema.decodeUnknownSync(Issue14ConformanceReportSchema)(value);
}

export function readIssue14ConformanceReport(path = reportPath): Issue14ConformanceReport {
  return decodeIssue14ConformanceReport(decodeJson(path));
}

export function assertConformanceReportInvariants(
  value: Schema.Json,
  options: ConformanceInvariantOptions = {}
): void {
  assertConformanceDecoded(decodeIssue14ConformanceReport(value), options);
}

export function assertStoredReportInvariants(
  value: Schema.Json,
  options: ConformanceInvariantOptions = {}
): void {
  assertStoredReportDecoded(decodeIssue14ConformanceReport(value), options);
}

async function main(): Promise<void> {
  assertCompilerIdentity();
  const writeTs7Index = process.argv.indexOf("--write-ts7");
  if (writeTs7Index >= 0) {
    const names = process.argv.slice(writeTs7Index + 1).filter((argument) => !argument.startsWith("--"));
    await writeAdditionalTs7Evidence(names);
    return;
  }
  const writeWarningsIndex = process.argv.indexOf("--write-warnings");
  if (writeWarningsIndex >= 0) {
    const names = process.argv.slice(writeWarningsIndex + 1).filter((argument) => !argument.startsWith("--"));
    await refreshWarningEvidence(names);
    return;
  }
  if (process.argv.some((argument) => argument.endsWith("output.json"))) {
    throw new Error("Issue 14 regeneration refuses to target the immutable output.json oracle.");
  }
  assertManifest();
  const writeReport = process.argv.includes("--write");
  const referenceMode = process.argv.includes("--reference-required") ? "required" : "optional";
  const referenceCheck = auditPinnedReference(referenceMode);
  if (process.argv.includes("--audit-reference")) {
    console.log(JSON.stringify(referenceCheck, null, 2));
    return;
  }
  const typechecks = conformanceFixtureManifest.map(typecheckFixture);
  const extractions = await extractAll();
  const measured = reportFrom(typechecks, extractions, referenceCheck);
  if (writeReport) {
    assertReferenceEvidence(measured.referenceCheck, true);
    await writeEvidenceBatch([
      {
        destination: "conformance.json",
        content: `${JSON.stringify(measured, null, 2)}\n`,
        evidence: "generated",
      },
    ]);
    return;
  }
  const stored = readIssue14ConformanceReport();
  assertStoredReport(stored, measured);
  console.log(
    JSON.stringify(
      {
        issue: measured.issue,
        totals: measured.totals,
        referenceCheck: measured.referenceCheck,
        status: measured.status,
      },
      null,
      2
    )
  );
}

await runIfMain(import.meta.url, main);
