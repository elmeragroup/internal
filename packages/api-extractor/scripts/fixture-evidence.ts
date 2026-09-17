import { Schema } from "effect";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ExtractionResult } from "../src/extractor.ts";
import { ModuleNodeSchema } from "../src/model.ts";
import type { ModuleNode } from "../src/model.ts";
import { ExtractWarningSchema } from "../src/warnings.ts";
import type { ExtractWarning } from "../src/warnings.ts";
import { pinnedTypeScript7Compiler } from "./fixture-catalog.ts";

/** The package's fixture root. */
export const fixtureDirectory = resolve(import.meta.dirname, "../test/fixtures");
/** The package root; the base for workspace-relative paths. */
export const packageDirectory = resolve(import.meta.dirname, "..");

export { decodeJson, packageVersion, posixRelative, sha256File } from "./files.ts";
import { decodeJson, posixRelative } from "./files.ts";

export * from "./fixture-catalog.ts";
export * from "./fixture-plans.ts";

import type { TimingFixture } from "./fixture-plans.ts";
import type { SupplementalBoundaryFixture } from "./fixture-plans.ts";

const TimingTotalsSchema = Schema.Struct({
  requestCount: Schema.Number,
  roundTripMs: Schema.Number,
  bytesSent: Schema.Number,
  bytesReceived: Schema.Number,
  serverTimeMs: Schema.Number,
  transportOverheadMs: Schema.Number,
  nodesMaterialized: Schema.Number,
  sourceFilesFetched: Schema.Number,
  nodesFetched: Schema.Number,
});

const BoundaryStatusSchema = Schema.Literals(["clear", "triggered"] as const);
const DecisionSchema = Schema.Literals(["go", "no-go"] as const);
const TimingStatusSchema = Schema.Literals(["not-triggered", "triggered"] as const);
const EvidenceTextSchema = Schema.String.check(Schema.isPattern(/\S/u));

const TimingReportSampleSchema = Schema.Struct({
  fixture: Schema.String,
  enabled: Schema.Boolean,
  totals: TimingTotalsSchema,
  fetchedToMaterializedRatio: Schema.Number,
  budget: Schema.Struct({
    maxFetchedToMaterializedRatio: Schema.Number,
    maxRequestCount: Schema.Number,
    maxBytesReceived: Schema.Number,
    bytesReceivedPathLengthHeadroom: Schema.optionalKey(Schema.Number),
  }),
});

const TimingStopConditionEvidenceSchema = Schema.Struct({
  status: BoundaryStatusSchema,
  evidence: EvidenceTextSchema,
});

const TimingIpcStopConditionEvidenceSchema = Schema.Struct({
  status: TimingStatusSchema,
  evidence: EvidenceTextSchema,
});

/** The Issue 02 boundary timing report: its samples, stop conditions, and go/no-go decision. */
export const TimingReportSchema = Schema.Struct({
  issue: Schema.Literal("02-prove-compiler-boundary"),
  command: Schema.String,
  runtime: Schema.Struct({
    node: Schema.String,
    compiler: Schema.String,
  }),
  samples: Schema.Array(TimingReportSampleSchema),
  stopConditions: Schema.Struct({
    backendLeakage: TimingStopConditionEvidenceSchema,
    durableContractLeakage: TimingStopConditionEvidenceSchema,
    unacceptableIpcGrowth: TimingIpcStopConditionEvidenceSchema,
  }),
  decision: DecisionSchema,
});

/** One persisted Issue 02 timing report. */
export type TimingReport = Schema.Schema.Type<typeof TimingReportSchema>;

type NodeTimingCounters = {
  readonly nodesFetched: number;
  readonly nodesMaterialized: number;
};

/**
 * The boundary's fetch amplification: nodes fetched over IPC per node materialized.
 *
 * @param counters - The IPC node counters to compare.
 * @returns `nodesFetched / nodesMaterialized`.
 * @throws When either counter is non-finite, `nodesFetched` is negative, or the denominator
 *   is not positive.
 */
export function fetchedToMaterializedRatio(counters: NodeTimingCounters): number {
  if (
    !Number.isFinite(counters.nodesFetched) ||
    !Number.isFinite(counters.nodesMaterialized) ||
    counters.nodesFetched < 0 ||
    counters.nodesMaterialized <= 0
  ) {
    throw new Error(
      "Fetched-to-materialized ratio requires finite node counters and a positive denominator."
    );
  }
  return counters.nodesFetched / counters.nodesMaterialized;
}

/** Whether a recorded duration or byte observation is finite and non-negative. */
function isTimingObservation(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Validates one measured or stored sample as an observation: the measurement
 * ran, made at least one request, and every recorded duration and byte count is
 * finite and non-negative. Live and stored samples share this predicate.
 */
export function assertTimingObservation(sample: TimingReport["samples"][number]): void {
  const totals = sample.totals;
  if (
    !sample.enabled ||
    !Number.isSafeInteger(totals.requestCount) ||
    totals.requestCount <= 0 ||
    !isTimingObservation(totals.roundTripMs) ||
    !isTimingObservation(totals.serverTimeMs) ||
    !isTimingObservation(totals.transportOverheadMs) ||
    !isTimingObservation(totals.bytesSent) ||
    !isTimingObservation(totals.bytesReceived)
  ) {
    throw new Error(`Timing observation is invalid for ${sample.fixture}.`);
  }
}

/** Validates the recorded ratio against its counters and its budget metadata. */
export function assertFetchedToMaterializedRatioEvidence(sample: TimingReport["samples"][number]): void {
  const expectedRatio = fetchedToMaterializedRatio(sample.totals);
  const reportedRatio = sample.fetchedToMaterializedRatio;
  const maxRatio = sample.budget.maxFetchedToMaterializedRatio;
  if (!Number.isFinite(reportedRatio) || reportedRatio !== expectedRatio) {
    throw new Error(`Fetched-to-materialized ratio evidence is stale for ${sample.fixture}.`);
  }
  if (!Number.isFinite(maxRatio) || maxRatio <= 0) {
    throw new Error(`Fetched-to-materialized ratio budget is invalid for ${sample.fixture}.`);
  }
  if (!Number.isSafeInteger(sample.budget.maxRequestCount) || sample.budget.maxRequestCount <= 0) {
    throw new Error(`Request-count budget is invalid for ${sample.fixture}.`);
  }
  if (!Number.isSafeInteger(sample.budget.maxBytesReceived) || sample.budget.maxBytesReceived <= 0) {
    throw new Error(`Bytes-received budget is invalid for ${sample.fixture}.`);
  }
  const pathLengthHeadroom = sample.budget.bytesReceivedPathLengthHeadroom;
  if (
    pathLengthHeadroom !== undefined &&
    (!Number.isSafeInteger(pathLengthHeadroom) || pathLengthHeadroom <= 0)
  ) {
    throw new Error(`Bytes-received path-length headroom is invalid for ${sample.fixture}.`);
  }
}

/** Asserts a sample's recorded ratio is coherent and within its budget ceiling. */
export function assertFetchedToMaterializedRatioBudget(sample: TimingReport["samples"][number]): void {
  assertFetchedToMaterializedRatioEvidence(sample);
  const reportedRatio = sample.fetchedToMaterializedRatio;
  const maxRatio = sample.budget.maxFetchedToMaterializedRatio;
  if (reportedRatio > maxRatio) {
    throw new Error(
      `Fetched-to-materialized ratio budget exceeded for ${sample.fixture}: ${reportedRatio} > ${maxRatio}.`
    );
  }
}

/** Asserts a stored sample's request count is valid and within its budget ceiling. */
export function assertRequestCountBudget(sample: TimingReport["samples"][number]): void {
  assertRequestCountCeiling({
    fixture: sample.fixture,
    requestCount: sample.totals.requestCount,
    maxRequestCount: sample.budget.maxRequestCount,
  });
}

/**
 * The bytes-received ceiling a budget allows, including its recorded path-length headroom.
 * `bytesReceived` varies with checkout paths, so the headroom absorbs that variance.
 */
export function bytesReceivedCeiling(budget: {
  readonly maxBytesReceived: number;
  readonly bytesReceivedPathLengthHeadroom?: number;
}): number {
  return budget.maxBytesReceived + (budget.bytesReceivedPathLengthHeadroom ?? 0);
}

/** The deterministic IPC gate: a sample stays within its catalog request-count and bytes-received ceilings. */
export function isWithinIpcBudget(sample: TimingReport["samples"][number]): boolean {
  return (
    sample.totals.requestCount <= sample.budget.maxRequestCount &&
    sample.totals.bytesReceived <= bytesReceivedCeiling(sample.budget)
  );
}

/** Asserts a stored sample's bytes received is valid and within its budget ceiling. */
export function assertBytesReceivedBudget(sample: TimingReport["samples"][number]): void {
  assertBytesReceivedCeiling({
    fixture: sample.fixture,
    bytesReceived: sample.totals.bytesReceived,
    maxBytesReceived: bytesReceivedCeiling(sample.budget),
  });
}

/** Asserts a request count is a positive integer and does not exceed its recorded ceiling. */
export function assertRequestCountCeiling(evidence: {
  readonly fixture: string;
  readonly requestCount: number;
  readonly maxRequestCount: number;
}): void {
  const { fixture, requestCount, maxRequestCount } = evidence;
  if (!Number.isSafeInteger(requestCount) || requestCount <= 0) {
    throw new Error(`Request-count evidence is invalid for ${fixture}.`);
  }
  if (!Number.isSafeInteger(maxRequestCount) || maxRequestCount <= 0) {
    throw new Error(`Request-count budget is invalid for ${fixture}.`);
  }
  if (requestCount > maxRequestCount) {
    throw new Error(`Request-count budget exceeded for ${fixture}: ${requestCount} > ${maxRequestCount}.`);
  }
}

/** Asserts a bytes-received observation is a non-negative integer within its ceiling. */
export function assertBytesReceivedCeiling(evidence: {
  readonly fixture: string;
  readonly bytesReceived: number;
  readonly maxBytesReceived: number;
}): void {
  const { fixture, bytesReceived, maxBytesReceived } = evidence;
  if (!Number.isSafeInteger(bytesReceived) || bytesReceived < 0) {
    throw new Error(`Bytes-received evidence is invalid for ${fixture}.`);
  }
  if (!Number.isSafeInteger(maxBytesReceived) || maxBytesReceived <= 0) {
    throw new Error(`Bytes-received budget is invalid for ${fixture}.`);
  }
  if (bytesReceived > maxBytesReceived) {
    throw new Error(`Bytes-received budget exceeded for ${fixture}: ${bytesReceived} > ${maxBytesReceived}.`);
  }
}

type ReactDivergenceArtifact = {
  readonly fixture: "base-ui-component";
  readonly compiler: typeof pinnedTypeScript7Compiler;
  readonly sourceOracle: "output.json";
  readonly comparison: "exact";
  readonly divergence: {
    readonly code: string;
    readonly reason: string;
    readonly genus: string;
    readonly upstreamPreserved: boolean;
    readonly differenceCount: number;
    readonly differenceDigest: string;
    readonly differencePaths?: readonly string[];
  };
};

const ReactDivergenceArtifactSchema = Schema.Struct({
  fixture: Schema.Literal("base-ui-component"),
  compiler: Schema.Literal(pinnedTypeScript7Compiler),
  sourceOracle: Schema.Literal("output.json"),
  comparison: Schema.Literal("exact"),
  divergence: Schema.Struct({
    code: EvidenceTextSchema,
    reason: EvidenceTextSchema,
    genus: EvidenceTextSchema,
    upstreamPreserved: Schema.Boolean,
    differenceCount: Schema.Natural,
    differenceDigest: EvidenceTextSchema,
    /** Legacy reviewed records carry count+digest; newer records may add paths. */
    differencePaths: Schema.optionalKey(Schema.Array(EvidenceTextSchema)),
  }),
});

const Ts7DivergenceArtifactSchema = Schema.Struct({
  fixture: Schema.String,
  compiler: Schema.Literal(pinnedTypeScript7Compiler),
  sourceOracle: Schema.Literal("output.json"),
  comparison: Schema.Literal("exact"),
  divergence: Schema.Struct({
    code: EvidenceTextSchema,
    reason: EvidenceTextSchema,
    /** A stable machine-readable genus for grouping, not a vague TS7 label. */
    genus: EvidenceTextSchema,
    upstreamPreserved: Schema.Boolean,
    differenceCount: Schema.Natural,
    differenceDigest: EvidenceTextSchema,
    /** Exact paths are optional for the legacy records; count+digest remain required. */
    differencePaths: Schema.optionalKey(Schema.Array(EvidenceTextSchema)),
  }),
});
function fixtureFile(fixture: string, file: string, fixtureRoot = fixtureDirectory): string {
  return resolve(fixtureRoot, fixture, file);
}

function isJsonObject(value: Schema.Json): value is Schema.JsonObject {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Schema.Json is decoded before recursive comparison.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses an already-decoded JSON value as a timing report.
 *
 * @param value - The decoded JSON to validate.
 * @returns The report.
 * @throws When the value does not match the report schema.
 */
export function decodeTimingReport(value: Schema.Json): TimingReport {
  return Schema.decodeUnknownSync(TimingReportSchema)(value);
}

/**
 * Reads and validates one persisted timing report.
 *
 * @param path - The report file path.
 * @returns The decoded report.
 * @throws When the file is unreadable or invalid.
 */
export function readTimingReport(path: string): TimingReport {
  return decodeTimingReport(decodeJson(path));
}

/** The absolute path of one fixture's input file. */
export function fixtureInputPath(definition: TimingFixture | SupplementalBoundaryFixture): string {
  return fixtureFile(definition.fixture, definition.file);
}

/** Reads and validates a fixture's selected module oracle. */
export function readModuleOracle(definition: TimingFixture): ModuleNode {
  return Schema.decodeUnknownSync(ModuleNodeSchema)(
    decodeJson(fixtureFile(definition.fixture, definition.oracleFile))
  );
}

/** Reads and validates a fixture's warning oracle. */
export function readWarningOracle(definition: TimingFixture): readonly ExtractWarning[] {
  return Schema.decodeUnknownSync(Schema.Array(ExtractWarningSchema))(
    decodeJson(fixtureFile(definition.fixture, definition.warningOracle))
  );
}

/**
 * Normalizes one path for durable warning evidence: TypeScript library paths become
 * `node_modules/typescript/lib/…`, workspace paths become package-relative, and anything
 * outside the package becomes `external/…`, so oracle bytes do not depend on checkout location.
 */
export function stableWarningPath(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  const typescriptLibMarker = "/node_modules/typescript/lib/";
  const libIndex = normalized.lastIndexOf(typescriptLibMarker);
  if (libIndex >= 0) {
    return `node_modules/typescript/lib/${normalized.slice(libIndex + typescriptLibMarker.length)}`;
  }
  const workspaceRelative = posixRelative(packageDirectory, filePath);
  return workspaceRelative.startsWith("../") ? "external/" + workspaceRelative : workspaceRelative;
}

/** Rewrites each warning's paths and message through `stableWarningPath` for byte comparison. */
export function normalizeWarnings(warnings: readonly ExtractWarning[]): readonly ExtractWarning[] {
  return warnings.map((warning) => {
    const normalizedFilePath = stableWarningPath(warning.filePath);
    const normalizedStack = warning.parsedSymbolStack.map((entry) =>
      entry.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(entry) ? stableWarningPath(entry) : entry
    );
    let message = warning.message.replaceAll(warning.filePath, normalizedFilePath);
    for (const [index, entry] of warning.parsedSymbolStack.entries()) {
      message = message.replaceAll(entry, normalizedStack[index] ?? entry);
    }
    return { ...warning, filePath: normalizedFilePath, parsedSymbolStack: normalizedStack, message };
  });
}

function leafPaths(value: Schema.Json | undefined, path: string): readonly string[] {
  if (value === undefined) return [];
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Schema.Json is decoded before recursive comparison.
  if (value === null || typeof value !== "object") return [path];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${path}/@length`];
    // oxlint-disable-next-line typescript/no-unsafe-argument -- JSON.parse values are decoded by Schema.Json immediately.
    return value.flatMap((entry, index) => leafPaths(entry, `${path}/${index}`));
  }
  if (!isJsonObject(value)) return [path];
  const keys = Object.keys(value);
  if (keys.length === 0) return [path];
  return keys.flatMap((key) => leafPaths(value[key], `${path}/${key}`));
}

function differencePaths(
  left: Schema.Json | undefined,
  right: Schema.Json | undefined,
  path = ""
): readonly string[] {
  if (left === undefined || right === undefined) {
    return left === right ? [] : [...leafPaths(left, path), ...leafPaths(right, path)];
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Schema.Json is decoded before recursive comparison.
  if (typeof left !== typeof right || left === null || right === null || typeof left !== "object") {
    return Object.is(left, right) ? [] : [path];
  }
  if (Array.isArray(left)) {
    if (!Array.isArray(right)) return [...leafPaths(left, path), ...leafPaths(right, path)];
    const result: string[] = left.length === right.length ? [] : [`${path}/@length`];
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      // oxlint-disable-next-line typescript/no-unsafe-argument -- JSON.parse values are decoded by Schema.Json immediately.
      result.push(...differencePaths(left[index], right[index], `${path}/${index}`));
    }
    return result;
  }
  if (Array.isArray(right)) return [...leafPaths(left, path), ...leafPaths(right, path)];
  if (!isJsonObject(left) || !isJsonObject(right)) return [path];
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].flatMap((key) => differencePaths(left[key], right[key], `${path}/${key}`));
}

/** The sorted, de-duplicated JSON leaf paths at which two decoded values differ. */
export function canonicalDifferencePaths(left: Schema.Json, right: Schema.Json): readonly string[] {
  return [...new Set(differencePaths(left, right))].sort();
}

/** SHA-256 of the canonical JSON encoding of the sorted, exact leaf paths. */
export function differenceDigest(paths: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...new Set(paths)].sort()), "utf8")
    .digest("hex");
}

function readReactDivergenceArtifact(fixtureRoot = fixtureDirectory): ReactDivergenceArtifact {
  return Schema.decodeUnknownSync(ReactDivergenceArtifactSchema)(
    decodeJson(fixtureFile("base-ui-component", "ts7-oracle.json", fixtureRoot))
  );
}

/**
 * Verifies the `base-ui-component` TS7 divergence record against the two oracles: the record
 * must retain a nonzero upstream difference, and its count, digest, and optional paths must
 * match the canonical difference exactly.
 *
 * @param fixtureRoot - The fixture root holding the oracles.
 * @throws When the difference is empty or the record is stale, incomplete, or unexplained.
 */
export function assertReactDivergenceEvidence(fixtureRoot = fixtureDirectory): void {
  const artifact = readReactDivergenceArtifact(fixtureRoot);
  const upstream = decodeJson(fixtureFile("base-ui-component", "output.json", fixtureRoot));
  const ts7 = decodeJson(fixtureFile("base-ui-component", "output.tsgo.json", fixtureRoot));
  const paths = canonicalDifferencePaths(upstream, ts7);
  if (paths.length === 0 || artifact.divergence.differenceCount === 0) {
    throw new Error("The React TS7 divergence must retain a nonzero upstream difference.");
  }
  if (
    artifact.divergence.differenceCount !== paths.length ||
    artifact.divergence.differenceDigest !== differenceDigest(paths) ||
    (artifact.divergence.differencePaths !== undefined &&
      JSON.stringify(artifact.divergence.differencePaths) !== JSON.stringify(paths))
  ) {
    throw new Error("The React TS7 divergence evidence is stale or incomplete.");
  }
  if (
    artifact.divergence.genus.length === 0 ||
    !artifact.divergence.upstreamPreserved ||
    artifact.divergence.reason.length === 0
  ) {
    throw new Error("The React TS7 divergence evidence must preserve and explain the upstream oracle.");
  }
}

/**
 * Validates a reviewed TypeScript 7 divergence record against the two oracles
 * it describes. The upstream oracle is never rewritten, so a stale record or a
 * silently regenerated TS7 oracle fails instead of hiding compiler drift.
 */
export function assertTs7DivergenceEvidence(fixture: string, fixtureRoot = fixtureDirectory): void {
  const artifact = Schema.decodeUnknownSync(Ts7DivergenceArtifactSchema)(
    decodeJson(fixtureFile(fixture, "ts7-oracle.json", fixtureRoot))
  );
  if (artifact.fixture !== fixture) {
    throw new Error(`The TS7 divergence record names a different fixture: ${fixture}`);
  }
  const paths = canonicalDifferencePaths(
    decodeJson(fixtureFile(fixture, "output.json", fixtureRoot)),
    decodeJson(fixtureFile(fixture, "output.tsgo.json", fixtureRoot))
  );
  if (
    artifact.divergence.differenceCount !== paths.length ||
    artifact.divergence.differenceDigest !== differenceDigest(paths)
  ) {
    throw new Error(`The TS7 divergence evidence is stale or incomplete: ${fixture}`);
  }
  if (
    artifact.divergence.differencePaths !== undefined &&
    JSON.stringify(artifact.divergence.differencePaths) !== JSON.stringify(paths)
  ) {
    throw new Error(`The TS7 divergence paths are stale or incomplete: ${fixture}`);
  }
  if (artifact.divergence.genus.trim().length === 0) {
    throw new Error(`The TS7 divergence genus must be non-empty: ${fixture}`);
  }
  if (paths.length === 0 || artifact.divergence.differenceCount === 0) {
    throw new Error(`The TS7 divergence must retain a nonzero upstream difference: ${fixture}`);
  }
  if (!artifact.divergence.upstreamPreserved || artifact.divergence.reason.length === 0) {
    throw new Error(`The TS7 divergence evidence must preserve and explain the upstream oracle: ${fixture}`);
  }
}

/** Reads and validates one named oracle file of a fixture as a module model. */
export function readFixtureOracle(fixture: string, oracleFile: string): ModuleNode {
  return Schema.decodeUnknownSync(ModuleNodeSchema)(decodeJson(fixtureFile(fixture, oracleFile)));
}

/**
 * Asserts a warning oracle file contains no host-dependent paths (absolute paths, drive
 * letters, or pnpm store paths), so the evidence stays comparable across checkouts.
 */
export function assertStableWarningOracle(definition: TimingFixture): void {
  const source = readFileSync(fixtureFile(definition.fixture, definition.warningOracle), "utf8");
  if (
    /(?:^|["':\s(])\/(?:[^"'\s]|\\.)+/u.test(source) ||
    /[A-Za-z]:[\\/]/u.test(source) ||
    /node_modules[\\/]\.pnpm[\\/]/u.test(source)
  ) {
    throw new Error(`The warning oracle contains an unstable path: ${definition.fixture}`);
  }
}

/**
 * Compares a live extraction against a fixture's reviewed module and warning oracles, after
 * normalizing paths. Also re-checks the React divergence record for its fixture.
 *
 * @param definition - The fixture and oracle files to compare against.
 * @param result - The live extraction result.
 * @throws When the module or normalized warnings differ from the checked-in oracle, or the
 *   warning oracle contains an unstable path.
 */
export function assertFixtureOracle(definition: TimingFixture, result: ExtractionResult): void {
  if (definition.fixture === "base-ui-component") assertReactDivergenceEvidence();
  if (JSON.stringify(result.module) !== JSON.stringify(readModuleOracle(definition))) {
    throw new Error(`The live fixture no longer matches its reviewed oracle: ${definition.fixture}`);
  }
  assertStableWarningOracle(definition);
  if (JSON.stringify(normalizeWarnings(result.warnings)) !== JSON.stringify(readWarningOracle(definition))) {
    throw new Error(
      `The live fixture warning output no longer matches its checked-in oracle: ${definition.fixture}`
    );
  }
}

/**
 * Asserts a public-seam regression fixture still exports exactly its expected names, as
 * objects, with no warnings.
 *
 * @param definition - The fixture and its expected export names.
 * @param result - The live extraction result.
 * @throws When the exports, their kinds, or the warning set changed.
 */
export function assertSupplementalFixture(
  definition: SupplementalBoundaryFixture,
  result: ExtractionResult
): void {
  const names = result.module.exports.map((entry) => entry.name);
  if (JSON.stringify(names) !== JSON.stringify(definition.expectedExports)) {
    throw new Error(`The live public-seam regression fixture changed: ${definition.fixture}`);
  }
  if (result.warnings.length > 0) {
    throw new Error(
      `The live public-seam regression fixture emitted unexpected warnings: ${definition.fixture}`
    );
  }
  if (result.module.exports.some((entry) => entry.type.kind !== "object")) {
    throw new Error(`The live public-seam regression fixture changed type resolution: ${definition.fixture}`);
  }
}
