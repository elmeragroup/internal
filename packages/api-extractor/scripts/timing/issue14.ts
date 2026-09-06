import { Schema } from "effect";
import { join } from "node:path";

import { writeArtifactBatchOrThrow } from "../artifact-batch-writer.ts";
import {
  issue14BackendLeakageEvidence,
  issue14CompilerVersion,
  issue14DurableContractLeakageEvidence,
  issue14IpcEvidence,
  issue14IpcThreshold,
  issue14TimingCommand,
  issue14TimingStableContract,
  issue14TimingWallClockContract,
  issue14TimingWallClockRationale,
} from "../conformance/contract.ts";
import { assertNodeMajor } from "../files.ts";
import {
  assertFixtureOracle,
  bytesReceivedCeiling,
  decodeJson,
  fixtureDirectory,
  fixtureInputPath,
  boundaryTimingFixtures,
  conformanceTimingFixtures,
  packageVersion,
  readTimingReport,
} from "../fixture-evidence.ts";
import type { TimingReport } from "../fixture-evidence.ts";
import { boundaryStatuses, timedExtraction } from "./shared.ts";
import type { BoundaryStatuses } from "./shared.ts";

const reportPath = join(fixtureDirectory, "timing-conformance.json");
const baselinePath = join(fixtureDirectory, "timing-boundary.json");
const configPath = join(fixtureDirectory, "conformance-tsconfig.json");
export const timingToleranceMs = 0.001;
/**
 * IPC wall-clock counters are scheduler-sensitive. Keep the durable timing
 * contract explicit: semantic counters must match exactly, wall-clock fields
 * remain finite non-negative observations, and the IPC stop condition is
 * decided by the aggregate request count and bytes received against the
 * catalog ceilings, so a loaded machine cannot flip the decision.
 */
export const wallClockContract = issue14TimingWallClockContract;
export const wallClockContractRationale = issue14TimingWallClockRationale;
const expectedFixtureOrder = conformanceTimingFixtures.map((definition) => definition.fixture);
const timingFields = ["roundTripMs", "serverTimeMs", "transportOverheadMs"] as const;
const semanticFields = ["requestCount", "nodesMaterialized", "sourceFilesFetched", "nodesFetched"] as const;
const transportByteFields = ["bytesSent", "bytesReceived"] as const;
const integerFields = [...semanticFields, ...transportByteFields] as const;

export const NumberTotalsSchema = Schema.Struct({
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
const SampleSchema = Schema.Struct({
  fixture: Schema.String,
  enabled: Schema.Boolean,
  baseline: NumberTotalsSchema,
  measured: NumberTotalsSchema,
  delta: NumberTotalsSchema,
});
const FixtureSamplesSchema = Schema.Array(SampleSchema).check(
  Schema.makeFilter((samples) => samples.length === 4 || "exactly four timing samples are required")
);

export const Issue14TimingReportSchema = Schema.Struct({
  issue: Schema.Literal("14-full-conformance"),
  command: Schema.Literal(issue14TimingCommand),
  runtime: Schema.Struct({
    node: Schema.String,
    compiler: Schema.Literal(issue14CompilerVersion),
  }),
  baseline: Schema.Struct({
    report: Schema.Literal("test/fixtures/timing-boundary.json"),
    aggregate: NumberTotalsSchema,
  }),
  measurement: Schema.Struct({
    stableContract: Schema.Literal(issue14TimingStableContract),
    wallClockContract: Schema.Literal(issue14TimingWallClockContract),
    rationale: Schema.Literal(issue14TimingWallClockRationale),
  }),
  samples: FixtureSamplesSchema,
  aggregate: Schema.Struct({
    baseline: NumberTotalsSchema,
    measured: NumberTotalsSchema,
    delta: NumberTotalsSchema,
  }),
  stopConditions: Schema.Struct({
    backendLeakage: Schema.Struct({
      status: Schema.Literals(["clear", "triggered"] as const),
      evidence: Schema.Literal(issue14BackendLeakageEvidence),
    }),
    durableContractLeakage: Schema.Struct({
      status: Schema.Literals(["clear", "triggered"] as const),
      evidence: Schema.Literal(issue14DurableContractLeakageEvidence),
    }),
    unacceptableIpcGrowth: Schema.Struct({
      status: Schema.Literals(["not-triggered", "triggered"] as const),
      threshold: Schema.Literal(issue14IpcThreshold),
      baselineAggregateRequestCount: Schema.Number,
      measuredAggregateRequestCount: Schema.Number,
      maxAggregateRequestCount: Schema.Number,
      baselineAggregateBytesReceived: Schema.Number,
      measuredAggregateBytesReceived: Schema.Number,
      maxAggregateBytesReceived: Schema.Number,
      evidence: Schema.Literal(issue14IpcEvidence),
    }),
  }),
  decision: Schema.Literals(["go", "no-go"] as const),
});

export const LiveBudgetTimingCommandOutputSchema = Schema.Struct({
  issue: Issue14TimingReportSchema.fields.issue,
  decision: Schema.Literals(["go", "no-go"] as const),
  mode: Schema.optionalKey(Schema.Never),
  semanticDecision: Schema.optionalKey(Schema.Never),
  baseline: Issue14TimingReportSchema.fields.baseline,
  aggregate: Issue14TimingReportSchema.fields.aggregate,
});

export const PortabilityTimingCommandOutputSchema = Schema.Struct({
  issue: Issue14TimingReportSchema.fields.issue,
  mode: Schema.Literal("portability"),
  semanticDecision: Schema.Literals(["go", "no-go"] as const),
  decision: Schema.optionalKey(Schema.Never),
  baseline: Issue14TimingReportSchema.fields.baseline,
  aggregate: Issue14TimingReportSchema.fields.aggregate,
});

export const TimingCommandOutputSchema = Schema.Union([
  LiveBudgetTimingCommandOutputSchema,
  PortabilityTimingCommandOutputSchema,
]);

export type Issue14TimingReport = Schema.Schema.Type<typeof Issue14TimingReportSchema>;
export type TimingCommandOutput = Schema.Schema.Type<typeof TimingCommandOutputSchema>;
export type TimingTotals = Schema.Schema.Type<typeof NumberTotalsSchema>;
export type TimingCheckMode = "enforce-live-budget" | "verify-checkout-portability";
export type SemanticDecision = "go" | "no-go";
type IpcCeilings = {
  readonly maxAggregateRequestCount: number;
  readonly maxAggregateBytesReceived: number;
};
type IpcStatus = Issue14TimingReport["stopConditions"]["unacceptableIpcGrowth"]["status"];

/** The Issue 14 IPC ceilings are the catalog's Issue 02 per-fixture ceilings summed over the four fixtures. */
export function issue14IpcCeilings(): IpcCeilings {
  const budgets = new Map(boundaryTimingFixtures.map((definition) => [definition.fixture, definition]));
  let maxAggregateRequestCount = 0;
  let maxAggregateBytesReceived = 0;
  for (const definition of conformanceTimingFixtures) {
    const budget = budgets.get(definition.fixture);
    if (budget === undefined) {
      throw new Error(`Issue 14 timing fixture ${definition.fixture} has no catalog IPC ceiling.`);
    }
    maxAggregateRequestCount += budget.maxRequestCount;
    maxAggregateBytesReceived += bytesReceivedCeiling(budget);
  }
  return { maxAggregateRequestCount, maxAggregateBytesReceived };
}

function ipcStatusFor(measured: TimingTotals, ceilings: IpcCeilings): IpcStatus {
  return measured.requestCount <= ceilings.maxAggregateRequestCount &&
    measured.bytesReceived <= ceilings.maxAggregateBytesReceived
    ? "not-triggered"
    : "triggered";
}

function currentRuntimeIdentity(): Issue14TimingReport["runtime"] {
  assertNodeMajor();
  const compiler = `typescript@${packageVersion("typescript")}`;
  if (compiler !== issue14CompilerVersion) {
    throw new Error(`Issue 14 timing evidence requires ${issue14CompilerVersion}.`);
  }
  return { node: process.versions.node, compiler };
}

function zeroTotals(): TimingTotals {
  return {
    requestCount: 0,
    roundTripMs: 0,
    bytesSent: 0,
    bytesReceived: 0,
    serverTimeMs: 0,
    transportOverheadMs: 0,
    nodesMaterialized: 0,
    sourceFilesFetched: 0,
    nodesFetched: 0,
  };
}

function addTotals(left: TimingTotals, right: TimingTotals): TimingTotals {
  return {
    requestCount: left.requestCount + right.requestCount,
    roundTripMs: left.roundTripMs + right.roundTripMs,
    bytesSent: left.bytesSent + right.bytesSent,
    bytesReceived: left.bytesReceived + right.bytesReceived,
    serverTimeMs: left.serverTimeMs + right.serverTimeMs,
    transportOverheadMs: left.transportOverheadMs + right.transportOverheadMs,
    nodesMaterialized: left.nodesMaterialized + right.nodesMaterialized,
    sourceFilesFetched: left.sourceFilesFetched + right.sourceFilesFetched,
    nodesFetched: left.nodesFetched + right.nodesFetched,
  };
}

function sumTotals(totals: readonly TimingTotals[]): TimingTotals {
  return totals.reduce(addTotals, zeroTotals());
}

export function subtractTotals(current: TimingTotals, baseline: TimingTotals): TimingTotals {
  return {
    requestCount: current.requestCount - baseline.requestCount,
    roundTripMs: current.roundTripMs - baseline.roundTripMs,
    bytesSent: current.bytesSent - baseline.bytesSent,
    bytesReceived: current.bytesReceived - baseline.bytesReceived,
    serverTimeMs: current.serverTimeMs - baseline.serverTimeMs,
    transportOverheadMs: current.transportOverheadMs - baseline.transportOverheadMs,
    nodesMaterialized: current.nodesMaterialized - baseline.nodesMaterialized,
    sourceFilesFetched: current.sourceFilesFetched - baseline.sourceFilesFetched,
    nodesFetched: current.nodesFetched - baseline.nodesFetched,
  };
}

function assertBaselineIdentity(baseline: TimingReport): void {
  assertNodeMajor(baseline.runtime.node);
  if (baseline.runtime.compiler !== issue14CompilerVersion) {
    throw new Error(`Issue 14 timing requires the ${issue14CompilerVersion} Issue 02 baseline.`);
  }
  if (
    JSON.stringify(baseline.samples.map((sample) => sample.fixture)) !== JSON.stringify(expectedFixtureOrder)
  ) {
    throw new Error("Issue 14 timing Issue 02 baseline fixture order is stale.");
  }
}

function assertTotalsFinite(label: string, totals: TimingTotals, allowNegative = false): void {
  for (const [field, value] of Object.entries(totals)) {
    if (!Number.isFinite(value)) throw new Error(`Invalid non-finite timing field ${label}.${field}.`);
  }
  for (const field of timingFields) {
    if (!allowNegative && totals[field] < 0) {
      throw new Error(`Timing field ${label}.${field} cannot be negative.`);
    }
  }
  for (const field of integerFields) {
    if (!Number.isInteger(totals[field]) || (!allowNegative && totals[field] < 0)) {
      throw new Error(
        `Timing counter ${label}.${field} must be an integer${allowNegative ? "" : " and non-negative"}.`
      );
    }
  }
  if (Math.abs(totals.roundTripMs - totals.serverTimeMs - totals.transportOverheadMs) > timingToleranceMs) {
    throw new Error(`Timing decomposition is stale for ${label}.`);
  }
}

function assertTotalsEqual(
  leftLabel: string,
  left: TimingTotals,
  rightLabel: string,
  right: TimingTotals,
  timingTolerance: number,
  allowNegative = false
): void {
  assertTotalsFinite(leftLabel, left, allowNegative);
  assertTotalsFinite(rightLabel, right, allowNegative);
  for (const field of integerFields) {
    if (left[field] !== right[field]) {
      throw new Error(
        `Timing counter ${field} differs: ${leftLabel}=${left[field]} vs ${rightLabel}=${right[field]}`
      );
    }
  }
  for (const field of timingFields) {
    if (Math.abs(left[field] - right[field]) > timingTolerance) {
      throw new Error(
        `Timing field ${field} differs beyond ${timingTolerance}ms: ${leftLabel}=${left[field]} vs ${rightLabel}=${right[field]}`
      );
    }
  }
}

export function assertSemanticTotalsEqual(
  leftLabel: string,
  left: TimingTotals,
  rightLabel: string,
  right: TimingTotals,
  allowNegative = false
): void {
  assertTotalsFinite(leftLabel, left, allowNegative);
  assertTotalsFinite(rightLabel, right, allowNegative);
  for (const field of semanticFields) {
    if (left[field] !== right[field]) {
      throw new Error(
        `Timing counter ${field} differs: ${leftLabel}=${left[field]} vs ${rightLabel}=${right[field]}`
      );
    }
  }
}

function assertArithmetic(label: string, actual: TimingTotals, expected: TimingTotals): void {
  for (const field of integerFields) {
    if (actual[field] !== expected[field]) {
      throw new Error(`Timing arithmetic is stale for ${label}.${field}.`);
    }
  }
  for (const field of timingFields) {
    if (Math.abs(actual[field] - expected[field]) > timingToleranceMs) {
      throw new Error(`Timing arithmetic is stale for ${label}.${field}.`);
    }
  }
}

function assertCommonReportInvariants(report: Issue14TimingReport): void {
  const issue = String(report.issue);
  const command = String(report.command);
  const runtimeNode = String(report.runtime.node);
  const runtimeCompiler = String(report.runtime.compiler);
  if (issue !== "14-full-conformance" || command !== issue14TimingCommand) {
    throw new Error("Issue 14 timing identity is stale.");
  }
  assertNodeMajor(runtimeNode);
  if (runtimeCompiler !== issue14CompilerVersion) {
    throw new Error("Issue 14 timing identity is stale.");
  }
  if (
    String(report.measurement.stableContract) !== issue14TimingStableContract ||
    String(report.measurement.wallClockContract) !== issue14TimingWallClockContract ||
    String(report.measurement.rationale) !== issue14TimingWallClockRationale
  ) {
    throw new Error("Issue 14 timing measurement contract is stale.");
  }
  if (
    String(report.stopConditions.backendLeakage.evidence) !== issue14BackendLeakageEvidence ||
    String(report.stopConditions.durableContractLeakage.evidence) !== issue14DurableContractLeakageEvidence ||
    String(report.stopConditions.unacceptableIpcGrowth.threshold) !== issue14IpcThreshold ||
    String(report.stopConditions.unacceptableIpcGrowth.evidence) !== issue14IpcEvidence
  ) {
    throw new Error("Issue 14 timing stop-condition evidence is stale.");
  }
  if (report.samples.length !== expectedFixtureOrder.length) {
    throw new Error("Issue 14 timing must contain exactly four samples.");
  }
  if (
    JSON.stringify(report.samples.map((sample) => sample.fixture)) !== JSON.stringify(expectedFixtureOrder)
  ) {
    throw new Error("Issue 14 timing fixture order is stale.");
  }

  for (const sample of report.samples) {
    assertTotalsFinite(`${report.issue}.${sample.fixture}.baseline`, sample.baseline);
    assertTotalsFinite(`${report.issue}.${sample.fixture}.measured`, sample.measured);
    assertTotalsFinite(`${report.issue}.${sample.fixture}.delta`, sample.delta, true);
    assertArithmetic(sample.fixture, sample.delta, subtractTotals(sample.measured, sample.baseline));
    if (!sample.enabled) throw new Error(`Issue 14 timing is disabled for ${sample.fixture}.`);
    if (
      sample.measured.requestCount <= 0 ||
      sample.measured.roundTripMs <= 0 ||
      sample.measured.nodesFetched <= 0
    ) {
      throw new Error(`Invalid measured Issue 14 timing sample: ${sample.fixture}.`);
    }
  }

  const baseline = sumTotals(report.samples.map((sample) => sample.baseline));
  const measured = sumTotals(report.samples.map((sample) => sample.measured));
  const delta = subtractTotals(measured, baseline);
  assertTotalsFinite("aggregate.baseline", report.aggregate.baseline);
  assertTotalsFinite("aggregate.measured", report.aggregate.measured);
  assertTotalsFinite("aggregate.delta", report.aggregate.delta, true);
  assertTotalsFinite("baseline.aggregate", report.baseline.aggregate);
  assertArithmetic("aggregate.baseline", report.aggregate.baseline, baseline);
  assertArithmetic("aggregate.measured", report.aggregate.measured, measured);
  assertArithmetic("aggregate.delta", report.aggregate.delta, delta);
  assertArithmetic(
    "aggregate.delta-vs-sum",
    report.aggregate.delta,
    sumTotals(report.samples.map((sample) => sample.delta))
  );
  assertArithmetic("baseline.aggregate", report.baseline.aggregate, baseline);
  const ipc = report.stopConditions.unacceptableIpcGrowth;
  if (
    ipc.baselineAggregateRequestCount !== baseline.requestCount ||
    ipc.measuredAggregateRequestCount !== measured.requestCount ||
    ipc.baselineAggregateBytesReceived !== baseline.bytesReceived ||
    ipc.measuredAggregateBytesReceived !== measured.bytesReceived
  ) {
    throw new Error("Issue 14 timing stop-condition arithmetic is stale.");
  }
  const ceilings = issue14IpcCeilings();
  if (
    ipc.maxAggregateRequestCount !== ceilings.maxAggregateRequestCount ||
    ipc.maxAggregateBytesReceived !== ceilings.maxAggregateBytesReceived
  ) {
    throw new Error("Issue 14 timing stop-condition ceilings are stale against the catalog.");
  }
  const expectedIpcStatus = ipcStatusFor(measured, ceilings);
  if (ipc.status !== expectedIpcStatus) {
    throw new Error("Issue 14 timing IPC status is stale.");
  }
  const expectedDecision =
    report.stopConditions.backendLeakage.status === "clear" &&
    report.stopConditions.durableContractLeakage.status === "clear" &&
    expectedIpcStatus === "not-triggered"
      ? "go"
      : "no-go";
  if (report.decision !== expectedDecision) throw new Error("Issue 14 timing decision is stale.");
}

export function assertTimingReportInvariants(report: Issue14TimingReport): void {
  assertCommonReportInvariants(report);
}

function reportFrom(
  baseline: TimingReport,
  samples: Issue14TimingReport["samples"],
  statuses: BoundaryStatuses
): Issue14TimingReport {
  assertBaselineIdentity(baseline);
  const baselineAggregate = sumTotals(samples.map((sample) => sample.baseline));
  const measuredAggregate = sumTotals(samples.map((sample) => sample.measured));
  const deltaAggregate = subtractTotals(measuredAggregate, baselineAggregate);
  const ceilings = issue14IpcCeilings();
  const ipcStatus = ipcStatusFor(measuredAggregate, ceilings);
  const report = {
    issue: "14-full-conformance" as const,
    command: issue14TimingCommand,
    runtime: currentRuntimeIdentity(),
    baseline: {
      report: "test/fixtures/timing-boundary.json" as const,
      aggregate: baselineAggregate,
    },
    measurement: {
      stableContract: issue14TimingStableContract,
      wallClockContract,
      rationale: wallClockContractRationale,
    },
    samples,
    aggregate: {
      baseline: baselineAggregate,
      measured: measuredAggregate,
      delta: deltaAggregate,
    },
    stopConditions: {
      backendLeakage: {
        status: statuses.backendLeakage,
        evidence: issue14BackendLeakageEvidence,
      },
      durableContractLeakage: {
        status: statuses.durableContractLeakage,
        evidence: issue14DurableContractLeakageEvidence,
      },
      unacceptableIpcGrowth: {
        status: ipcStatus,
        threshold: issue14IpcThreshold,
        baselineAggregateRequestCount: baselineAggregate.requestCount,
        measuredAggregateRequestCount: measuredAggregate.requestCount,
        maxAggregateRequestCount: ceilings.maxAggregateRequestCount,
        baselineAggregateBytesReceived: baselineAggregate.bytesReceived,
        measuredAggregateBytesReceived: measuredAggregate.bytesReceived,
        maxAggregateBytesReceived: ceilings.maxAggregateBytesReceived,
        evidence: issue14IpcEvidence,
      },
    },
    decision:
      statuses.backendLeakage === "clear" &&
      statuses.durableContractLeakage === "clear" &&
      ipcStatus === "not-triggered"
        ? "go"
        : "no-go",
  } satisfies Issue14TimingReport;
  assertArithmetic(
    "baseline-report",
    report.baseline.aggregate,
    sumTotals(baseline.samples.map((sample) => sample.totals))
  );
  assertCommonReportInvariants(report);
  return report;
}

async function measure(): Promise<Issue14TimingReport> {
  const baseline = readTimingReport(baselinePath);
  assertBaselineIdentity(baseline);
  const baselineSamples = new Map(baseline.samples.map((sample) => [sample.fixture, sample]));
  const samples: Array<Issue14TimingReport["samples"][number]> = [];
  for (const definition of conformanceTimingFixtures) {
    const baselineSample = baselineSamples.get(definition.fixture);
    if (baselineSample === undefined) {
      throw new Error(`Missing Issue 02 baseline sample: ${definition.fixture}`);
    }
    const extraction = await timedExtraction(configPath, fixtureInputPath(definition));
    assertFixtureOracle(definition, extraction.result);
    const measured = extraction.timing.totals;
    const sample = {
      fixture: definition.fixture,
      enabled: extraction.timing.enabled,
      baseline: baselineSample.totals,
      measured,
      delta: subtractTotals(measured, baselineSample.totals),
    } satisfies Issue14TimingReport["samples"][number];
    samples.push(sample);
  }
  const statuses = boundaryStatuses();
  return reportFrom(baseline, samples, statuses);
}

function decodeReport(value: Schema.Json): Issue14TimingReport {
  return Schema.decodeUnknownSync(Issue14TimingReportSchema)(value);
}

export function assertStoredTimingReport(
  stored: Issue14TimingReport,
  measured: Issue14TimingReport,
  mode: TimingCheckMode
): SemanticDecision {
  assertCommonReportInvariants(stored);
  assertCommonReportInvariants(measured);
  if (
    stored.stopConditions.backendLeakage.status !== measured.stopConditions.backendLeakage.status ||
    stored.stopConditions.durableContractLeakage.status !==
      measured.stopConditions.durableContractLeakage.status ||
    stored.decision !== "go"
  ) {
    throw new Error("Issue 14 timing boundary status or stored decision is stale.");
  }
  if (
    mode === "enforce-live-budget" &&
    (stored.stopConditions.unacceptableIpcGrowth.status !==
      measured.stopConditions.unacceptableIpcGrowth.status ||
      measured.decision !== "go")
  ) {
    throw new Error("Issue 14 IPC stop condition is triggered.");
  }

  // Issue 02 is an immutable pre-optimization observation set. Issue 14
  // compares its baseline fields with that artifact, then owns exact current
  // semantic counters from `measured`; live budget enforcement stays in the
  // fresh Issue 02 measurement and is not made circular with the baseline.
  const currentBaseline = readTimingReport(baselinePath);
  assertBaselineIdentity(currentBaseline);
  const currentBaselineByFixture = new Map(currentBaseline.samples.map((sample) => [sample.fixture, sample]));
  const expectedBaselineAggregate = sumTotals(currentBaseline.samples.map((sample) => sample.totals));
  assertTotalsEqual(
    "stored baseline aggregate",
    stored.baseline.aggregate,
    "current Issue 02 baseline aggregate",
    expectedBaselineAggregate,
    timingToleranceMs
  );
  assertTotalsEqual(
    "stored aggregate baseline",
    stored.aggregate.baseline,
    "current Issue 02 baseline aggregate",
    expectedBaselineAggregate,
    timingToleranceMs
  );
  for (let index = 0; index < stored.samples.length; index += 1) {
    const storedSample = stored.samples[index];
    const measuredSample = measured.samples[index];
    if (storedSample === undefined || measuredSample === undefined) {
      throw new Error(`Issue 14 timing sample is missing at index ${index}.`);
    }
    const baselineSample = currentBaselineByFixture.get(storedSample.fixture);
    if (baselineSample === undefined || measuredSample.fixture !== storedSample.fixture) {
      throw new Error(`Issue 14 timing sample identity is stale at index ${index}.`);
    }
    assertTotalsEqual(
      `${storedSample.fixture} stored baseline`,
      storedSample.baseline,
      `${storedSample.fixture} current Issue 02 baseline`,
      baselineSample.totals,
      timingToleranceMs
    );
    assertSemanticTotalsEqual(
      `${storedSample.fixture} stored measured`,
      storedSample.measured,
      `${storedSample.fixture} live measured`,
      measuredSample.measured
    );
    assertSemanticTotalsEqual(
      `${storedSample.fixture} stored delta`,
      storedSample.delta,
      `${storedSample.fixture} live delta`,
      measuredSample.delta,
      true
    );
    assertArithmetic(
      `${storedSample.fixture} stored delta`,
      storedSample.delta,
      subtractTotals(storedSample.measured, storedSample.baseline)
    );
  }
  assertSemanticTotalsEqual(
    "stored measured aggregate",
    stored.aggregate.measured,
    "live measured aggregate",
    measured.aggregate.measured
  );
  assertSemanticTotalsEqual(
    "stored delta aggregate",
    stored.aggregate.delta,
    "live delta aggregate",
    measured.aggregate.delta,
    true
  );
  return "go";
}

export function timingCommandOutput(
  measured: Issue14TimingReport,
  mode: TimingCheckMode,
  semanticDecision: SemanticDecision
): TimingCommandOutput {
  return mode === "verify-checkout-portability"
    ? {
        issue: measured.issue,
        mode: "portability",
        semanticDecision,
        baseline: measured.baseline,
        aggregate: measured.aggregate,
      }
    : {
        issue: measured.issue,
        decision: measured.decision,
        baseline: measured.baseline,
        aggregate: measured.aggregate,
      };
}

/** Measures the live Issue 14 report; `write` stores it, either check mode compares it with the stored evidence. */
export async function runIssue14Timing(mode: TimingCheckMode | "write"): Promise<void> {
  const measured = await measure();
  if (mode === "write") {
    await writeArtifactBatchOrThrow(
      {
        outputRoot: fixtureDirectory,
        artifacts: [
          {
            destination: "timing-conformance.json",
            content: `${JSON.stringify(measured, null, 2)}\n`,
            evidence: "generated",
          },
        ],
      },
      "Issue 14 timing artifact write"
    );
    return;
  }
  const stored = decodeReport(decodeJson(reportPath));
  const semanticDecision = assertStoredTimingReport(stored, measured, mode);
  const output = timingCommandOutput(measured, mode, semanticDecision);
  console.log(JSON.stringify(Schema.encodeSync(TimingCommandOutputSchema)(output), null, 2));
}
