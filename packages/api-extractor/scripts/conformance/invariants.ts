import { Schema } from "effect";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  assertTs7DivergenceEvidence,
  canonicalDifferencePaths,
  differenceDigest,
  fixtureDirectory,
  decodeJson,
  sha256File,
} from "../fixture-evidence.ts";
import { conformanceFixtureManifest } from "../fixture-plans.ts";
import type { ConformanceFixture } from "../fixture-plans.ts";
import { pinnedFixturePathUniverse, pinnedUpstream, skippedPathUniverseSha256 } from "../reference.ts";
import {
  issue14ConformanceCommand,
  issue14SelectedOracleFile,
  issue14TypecheckCommand,
  issue14TypecheckStrategy,
} from "./contract.ts";
import type { Issue14ConformanceReport } from "./report.ts";

const expectedFixtureCount = 116;
const emptyDifferenceDigest = differenceDigest([]);

function warningOraclePathAt(fixtureRoot: string, fixture: string): string | undefined {
  const path = join(fixtureRoot, fixture, "warnings.tsgo.json");
  return existsSync(path) ? path : undefined;
}

function relativeFixturePath(path: string, fixtureRoot: string): string {
  return path.slice(fixtureRoot.length + 1).replaceAll("\\", "/");
}

function expectedWarningsAt(fixtureRoot: string, fixture: string): readonly Schema.Json[] {
  const path = warningOraclePathAt(fixtureRoot, fixture);
  return Schema.decodeUnknownSync(Schema.Array(Schema.Json))(path === undefined ? [] : decodeJson(path));
}

function warningDigest(warnings: readonly Schema.Json[]): string {
  return createHash("sha256").update(JSON.stringify(warnings), "utf8").digest("hex");
}

type FixtureStatusRecord = {
  readonly status: string;
};

export type FixtureRunSummary = {
  readonly fixtures: number;
  readonly unchanged: number;
  readonly reviewedDivergences: number;
  readonly failures: number;
  readonly failedFixtureIndices: readonly number[];
  readonly unclassified: number;
  readonly typecheckPassed: number;
  readonly typecheckFailed: number;
  readonly status: "pass" | "failed";
};

/** Derive the complete status vector from one ordered fixture run. */
export function summarizeFixtureRun(
  definitions: readonly ConformanceFixture[],
  typechecks: readonly FixtureStatusRecord[],
  extractions: readonly FixtureStatusRecord[]
): FixtureRunSummary {
  if (definitions.length !== typechecks.length || definitions.length !== extractions.length) {
    throw new Error("Issue 14 fixture summaries require equal ordered inputs.");
  }
  const failedFixtureIndices: number[] = [];
  for (let index = 0; index < definitions.length; index += 1) {
    if (typechecks[index]?.status !== "pass" || extractions[index]?.status !== "match") {
      failedFixtureIndices.push(index);
    }
  }
  const unclassified = definitions.filter((definition) => {
    const disposition = String(definition.disposition);
    return disposition !== "unchanged" && disposition !== "reviewed-ts7";
  }).length;
  const typecheckFailed = typechecks.filter((typecheck) => typecheck.status !== "pass").length;
  return {
    fixtures: definitions.length,
    unchanged: definitions.filter((definition) => definition.disposition === "unchanged").length,
    reviewedDivergences: definitions.filter((definition) => definition.disposition === "reviewed-ts7").length,
    failures: failedFixtureIndices.length,
    failedFixtureIndices,
    unclassified,
    typecheckPassed: typechecks.length - typecheckFailed,
    typecheckFailed,
    status: failedFixtureIndices.length === 0 && unclassified === 0 ? "pass" : "failed",
  };
}

function expectedReferenceAuditCommand(mode: "optional" | "required"): string {
  return `reference audit ${mode} ${pinnedUpstream.repository}@${pinnedUpstream.commit}`;
}

export function assertReferenceEvidence(
  referenceCheck: Issue14ConformanceReport["referenceCheck"],
  requireVerified: boolean
): void {
  const repository = String(referenceCheck.repository);
  const commit = String(referenceCheck.commit);
  const command = String(referenceCheck.command);
  const pathCommand = String(referenceCheck.pathUniverse.command);
  if (
    repository !== pinnedUpstream.repository ||
    commit !== pinnedUpstream.commit ||
    command !== expectedReferenceAuditCommand(referenceCheck.mode) ||
    pathCommand !== pinnedFixturePathUniverse.command
  ) {
    throw new Error("Issue 14 reference identity or audit command is stale.");
  }
  if (referenceCheck.status === "verified") {
    if (
      referenceCheck.fixtureCount !== expectedFixtureCount ||
      referenceCheck.comparedFiles !== pinnedFixturePathUniverse.count ||
      referenceCheck.pathUniverse.count !== pinnedFixturePathUniverse.count ||
      referenceCheck.pathUniverse.sha256 !== pinnedFixturePathUniverse.sha256
    ) {
      throw new Error("Issue 14 verified reference path-universe evidence is stale.");
    }
    return;
  }
  if (
    requireVerified ||
    referenceCheck.fixtureCount !== 0 ||
    referenceCheck.comparedFiles !== 0 ||
    referenceCheck.pathUniverse.count !== 0 ||
    referenceCheck.pathUniverse.sha256 !== skippedPathUniverseSha256
  ) {
    throw new Error(
      "Issue 14 reference evidence is skipped or incomplete where verified evidence is required."
    );
  }
}

function assertFixtureRecord(
  record: Issue14ConformanceReport["fixtures"][number],
  definition: ConformanceFixture,
  index: number,
  fixtureRoot: string
): void {
  const inputPath = join(fixtureRoot, definition.fixture, definition.file);
  const upstreamPath = join(fixtureRoot, definition.fixture, "output.json");
  const selectedOracleFile = issue14SelectedOracleFile(definition);
  const selectedOraclePath = join(fixtureRoot, definition.fixture, selectedOracleFile);
  const expectedWarningPath = warningOraclePathAt(fixtureRoot, definition.fixture);
  const warnings = expectedWarningsAt(fixtureRoot, definition.fixture);

  if (
    record.fixture !== definition.fixture ||
    record.input !== definition.file ||
    record.disposition !== definition.disposition ||
    record.inputSha256 !== sha256File(inputPath) ||
    record.upstreamOracleSha256 !== sha256File(upstreamPath) ||
    record.extraction.selectedOracleSha256 !== sha256File(selectedOraclePath)
  ) {
    throw new Error(`Issue 14 persisted fixture identity or hash is stale at index ${index}.`);
  }
  if (
    record.typecheck.status !== "pass" ||
    record.typecheck.strategy !== issue14TypecheckStrategy(definition) ||
    record.typecheck.command !== issue14TypecheckCommand(definition) ||
    record.typecheck.diagnosticCount !== 0 ||
    record.typecheck.diagnostics.length !== 0
  ) {
    throw new Error(`Issue 14 persisted typecheck evidence is stale for ${definition.fixture}.`);
  }
  if (!existsSync(selectedOraclePath)) {
    throw new Error(`Issue 14 selected oracle is missing for ${definition.fixture}.`);
  }

  const upstreamDifferences = canonicalDifferencePaths(
    decodeJson(upstreamPath),
    decodeJson(selectedOraclePath)
  );
  const expectedDivergenceRecord =
    definition.disposition === "reviewed-ts7" ? `${definition.fixture}/ts7-oracle.json` : undefined;
  if (
    record.extraction.status !== "match" ||
    record.extraction.oracleFile !== selectedOracleFile ||
    record.extraction.differenceCount !== 0 ||
    record.extraction.differenceDigest !== emptyDifferenceDigest ||
    record.extraction.upstreamDifferenceCount !== upstreamDifferences.length ||
    record.extraction.upstreamDifferenceDigest !== differenceDigest(upstreamDifferences) ||
    record.extraction.error !== undefined ||
    record.extraction.divergenceRecord !== expectedDivergenceRecord
  ) {
    throw new Error(`Issue 14 persisted extraction evidence is stale for ${definition.fixture}.`);
  }
  if (definition.disposition === "reviewed-ts7") {
    if (upstreamDifferences.length === 0) {
      throw new Error(
        `Reviewed TS7 fixture must retain a nonzero upstream divergence: ${definition.fixture}`
      );
    }
    assertTs7DivergenceEvidence(definition.fixture, fixtureRoot);
  } else if (upstreamDifferences.length !== 0) {
    throw new Error(`Unchanged fixture cannot carry reviewed divergence evidence: ${definition.fixture}`);
  }

  if (
    record.extraction.warningCount !== warnings.length ||
    JSON.stringify(record.extraction.warningDetails) !== JSON.stringify(warnings) ||
    record.extraction.warningDigest !== warningDigest(warnings) ||
    record.extraction.warningOracle !==
      (expectedWarningPath === undefined ? undefined : relativeFixturePath(expectedWarningPath, fixtureRoot))
  ) {
    throw new Error(`Issue 14 persisted warning evidence is stale for ${definition.fixture}.`);
  }
}

export type ConformanceInvariantOptions = {
  readonly fixtureRoot?: string;
};

export function assertConformanceDecoded(
  report: Issue14ConformanceReport,
  options: ConformanceInvariantOptions = {}
): void {
  const fixtureRoot = options.fixtureRoot ?? fixtureDirectory;
  const issue = String(report.issue);
  const command = String(report.command);
  const upstreamRepository = String(report.upstream.repository);
  const upstreamCommit = String(report.upstream.commit);
  const upstreamFixtureCount = Number(report.upstream.fixtureCount);
  const originalOracle = String(report.upstream.originalOracle);
  if (
    issue !== "14-full-conformance" ||
    command !== issue14ConformanceCommand ||
    upstreamRepository !== pinnedUpstream.repository ||
    upstreamCommit !== pinnedUpstream.commit ||
    upstreamFixtureCount !== expectedFixtureCount ||
    originalOracle !== "output.json"
  ) {
    throw new Error("Issue 14 conformance identity is stale.");
  }
  if (report.manifestSha256 !== manifestSha256()) {
    throw new Error("Issue 14 fixture manifest digest is stale.");
  }
  assertReferenceEvidence(report.referenceCheck, false);
  const manifestNames = conformanceFixtureManifest.map((fixture) => fixture.fixture);
  const names = report.fixtures.map((fixture) => fixture.fixture);
  if (
    report.fixtures.length !== expectedFixtureCount ||
    JSON.stringify(names) !== JSON.stringify(manifestNames) ||
    new Set(names).size !== names.length
  ) {
    throw new Error("Issue 14 report fixture records must be the unique ordered manifest set.");
  }

  const summary = summarizeFixtureRun(
    conformanceFixtureManifest,
    report.fixtures.map((fixture) => fixture.typecheck),
    report.fixtures.map((fixture) => fixture.extraction)
  );
  const expectedTotals = {
    fixtures: summary.fixtures,
    unchanged: summary.unchanged,
    reviewedDivergences: summary.reviewedDivergences,
    failures: summary.failures,
    failedFixtureIndices: summary.failedFixtureIndices,
    unclassified: summary.unclassified,
    typecheckPassed: summary.typecheckPassed,
    typecheckFailed: summary.typecheckFailed,
  };
  if (JSON.stringify(report.totals) !== JSON.stringify(expectedTotals)) {
    throw new Error("Issue 14 report totals do not derive from its fixture records.");
  }
  for (let index = 0; index < expectedFixtureCount; index += 1) {
    const record = report.fixtures[index];
    const definition = conformanceFixtureManifest[index];
    if (record === undefined || definition === undefined) {
      throw new Error(`Issue 14 report is missing fixture index ${index}.`);
    }
    assertFixtureRecord(record, definition, index, fixtureRoot);
  }
  if (report.status !== summary.status) {
    throw new Error("Issue 14 report status is inconsistent with its records.");
  }
}

/** The stable identity of the fixture manifest every conformance report is bound to. */
export function manifestSha256(): string {
  return createHash("sha256").update(JSON.stringify(conformanceFixtureManifest), "utf8").digest("hex");
}

export function assertStoredReportDecoded(
  report: Issue14ConformanceReport,
  options: ConformanceInvariantOptions = {}
): void {
  assertConformanceDecoded(report, options);
  assertReferenceEvidence(report.referenceCheck, true);
  if (report.status !== "pass") throw new Error("Issue 14 persisted conformance is not green.");
}

export function assertStoredReport(
  stored: Issue14ConformanceReport,
  measured: Issue14ConformanceReport
): void {
  assertStoredReportDecoded(stored);
  assertConformanceDecoded(measured);
  if (
    JSON.stringify(stored.upstream) !== JSON.stringify(measured.upstream) ||
    stored.manifestSha256 !== measured.manifestSha256
  ) {
    throw new Error("Issue 14 persisted identity or manifest evidence is stale.");
  }
  if (
    String(stored.referenceCheck.repository) !== String(measured.referenceCheck.repository) ||
    String(stored.referenceCheck.commit) !== String(measured.referenceCheck.commit) ||
    stored.referenceCheck.mode !== measured.referenceCheck.mode
  ) {
    throw new Error("Issue 14 reference identity or audit mode is stale.");
  }
  if (
    measured.referenceCheck.status === "verified" &&
    JSON.stringify(stored.referenceCheck) !== JSON.stringify(measured.referenceCheck)
  ) {
    throw new Error("Issue 14 verified reference evidence is stale.");
  }
  if (JSON.stringify(stored.totals) !== JSON.stringify(measured.totals)) {
    throw new Error("Issue 14 conformance totals are stale.");
  }
  if (stored.status !== "pass" || measured.status !== "pass") {
    throw new Error("Issue 14 conformance is not green.");
  }
  for (let index = 0; index < conformanceFixtureManifest.length; index += 1) {
    const expected = measured.fixtures[index];
    const actual = stored.fixtures[index];
    if (
      expected === undefined ||
      actual === undefined ||
      JSON.stringify(actual) !== JSON.stringify(expected)
    ) {
      throw new Error(`Issue 14 report is stale at fixture index ${index}.`);
    }
  }
}
