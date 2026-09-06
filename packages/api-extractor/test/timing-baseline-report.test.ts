import { Effect } from "effect";
import { Schema } from "effect";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertBytesReceivedBudget,
  assertFetchedToMaterializedRatioBudget,
  assertFetchedToMaterializedRatioEvidence,
  assertRequestCountBudget,
  bytesReceivedCeiling,
  decodeTimingReport,
  fetchedToMaterializedRatio,
  fixtureInputPath,
  boundaryTimingFixtures,
  readTimingReport,
} from "../scripts/fixture-evidence.ts";
import { ProjectExtractor } from "../src/index.ts";
import { InternalProjectExtractorTiming, timedProjectExtractorLayer } from "../src/internal/timing.ts";

const fixtureDirectory = resolve(import.meta.dirname, "fixtures");
const tsconfigPath = resolve(fixtureDirectory, "timing-boundary-tsconfig.json");
const timingReportPath = resolve(fixtureDirectory, "timing-boundary.json");

describe("Issue 02 compiler timing boundary", () => {
  it("decodes complete checked-in artifacts and rejects malformed nested fields", () => {
    const timing = readTimingReport(timingReportPath);

    const firstTimingSample = timing.samples[0];
    expect(firstTimingSample?.totals.nodesFetched).toBeGreaterThan(0);
    if (firstTimingSample === undefined) throw new Error("Missing representative timing sample.");
    expect(firstTimingSample.fetchedToMaterializedRatio).toBe(
      fetchedToMaterializedRatio(firstTimingSample.totals)
    );
    expect(() => assertFetchedToMaterializedRatioEvidence(firstTimingSample)).not.toThrow();
    expect(timing.stopConditions.backendLeakage.evidence).toContain("check-boundary.ts");
    expect(timing.stopConditions.durableContractLeakage.evidence).toContain("backend contracts");
    expect(timing.stopConditions.unacceptableIpcGrowth.evidence).toContain("all four");

    const malformedTiming = {
      ...timing,
      samples: timing.samples.map((sample, index) =>
        index === 0 ? { ...sample, totals: { ...sample.totals, nodesFetched: "not-a-number" } } : sample
      ),
    } satisfies Schema.Json;
    expect(() => decodeTimingReport(malformedTiming)).toThrow();

    const malformedRatio = {
      ...timing,
      samples: timing.samples.map((sample, index) =>
        index === 0 ? { ...sample, fetchedToMaterializedRatio: "not-a-number" } : sample
      ),
    } satisfies Schema.Json;
    expect(() => decodeTimingReport(malformedRatio)).toThrow();

    const missingTimingEvidence = {
      ...timing,
      stopConditions: {
        ...timing.stopConditions,
        backendLeakage: { status: timing.stopConditions.backendLeakage.status },
      },
    } satisfies Schema.Json;
    expect(() => decodeTimingReport(missingTimingEvidence)).toThrow();
  });

  it("rejects stale fetched-to-materialized ratio evidence", () => {
    const timing = readTimingReport(timingReportPath);
    const sample = timing.samples[0];
    if (sample === undefined) throw new Error("Missing representative timing sample.");

    expect(() =>
      assertFetchedToMaterializedRatioEvidence({
        ...sample,
        fetchedToMaterializedRatio: sample.fetchedToMaterializedRatio + 1,
      })
    ).toThrow(/evidence is stale/u);
  });

  it("keeps immutable baseline observations separate from live budget enforcement", () => {
    const timing = readTimingReport(timingReportPath);
    const baselineSample = timing.samples.find((candidate) => candidate.fixture === "base-ui-component");
    if (baselineSample === undefined) throw new Error("Missing base-ui baseline sample.");

    // The stored sample predates the live request/ratio ceilings and is kept
    // as historical evidence. Its semantic observations remain valid even
    // though both current budgets would reject them.
    expect(() => assertFetchedToMaterializedRatioEvidence(baselineSample)).not.toThrow();
    expect(() => assertFetchedToMaterializedRatioBudget(baselineSample)).toThrow(/budget exceeded/u);
    expect(() => assertRequestCountBudget(baselineSample)).toThrow(/budget exceeded/u);
  });

  it("keeps an over-budget ratio reportable for write mode and rejects it in check mode", () => {
    const report = readTimingReport(timingReportPath);
    const sample = report.samples[0];
    if (sample === undefined) throw new Error("Missing representative timing sample.");
    const overBudgetSample = {
      ...sample,
      budget: {
        ...sample.budget,
        maxFetchedToMaterializedRatio: sample.fetchedToMaterializedRatio - 0.001,
      },
    };

    expect(() => assertFetchedToMaterializedRatioEvidence(overBudgetSample)).not.toThrow();
    const serialized = decodeTimingReport(
      Schema.decodeUnknownSync(Schema.Json)(
        JSON.parse(
          JSON.stringify({
            ...report,
            samples: [overBudgetSample, ...report.samples.slice(1)],
          })
        )
      )
    );
    expect(serialized.samples[0]?.fetchedToMaterializedRatio).toBe(
      overBudgetSample.fetchedToMaterializedRatio
    );
    expect(() => assertFetchedToMaterializedRatioBudget(overBudgetSample)).toThrow(/budget exceeded/u);
  });

  it("rejects a request count above its fixture-owned limit", () => {
    const report = readTimingReport(timingReportPath);
    const sample = report.samples.find(
      (candidate) => candidate.fixture === "module-dts-declarations-and-reexports"
    );
    if (sample === undefined) throw new Error("Missing re-export timing sample.");
    const overBudget = {
      ...sample,
      totals: { ...sample.totals, requestCount: sample.budget.maxRequestCount + 1 },
    };

    expect(() => assertRequestCountBudget(overBudget)).toThrow(/budget exceeded/u);
  });

  it("rejects bytes received above its fixture-owned limit", () => {
    const report = readTimingReport(timingReportPath);
    const sample = report.samples.find(
      (candidate) => candidate.fixture === "module-dts-declarations-and-reexports"
    );
    if (sample === undefined) throw new Error("Missing re-export timing sample.");
    const overBudget = {
      ...sample,
      totals: { ...sample.totals, bytesReceived: sample.budget.maxBytesReceived + 1 },
    };

    expect(() => assertBytesReceivedBudget(overBudget)).toThrow(/budget exceeded/u);
  });

  it("absorbs path-length slack on alias/mapped bytes without admitting a megabyte dump", () => {
    const report = readTimingReport(timingReportPath);
    const sample = report.samples.find((candidate) => candidate.fixture === "alias-with-explicit-type-args");
    if (sample === undefined) throw new Error("Missing alias timing sample.");
    expect(sample.budget.bytesReceivedPathLengthHeadroom).toBeGreaterThan(0);
    const withinHeadroom = {
      ...sample,
      totals: { ...sample.totals, bytesReceived: sample.budget.maxBytesReceived + 1 },
    };
    const overCeiling = {
      ...sample,
      totals: { ...sample.totals, bytesReceived: bytesReceivedCeiling(sample.budget) + 1 },
    };
    const megabyteDump = {
      ...sample,
      totals: { ...sample.totals, bytesReceived: 1_000_000 },
    };

    expect(() => assertBytesReceivedBudget(withinHeadroom)).not.toThrow();
    expect(() => assertBytesReceivedBudget(overCeiling)).toThrow(/budget exceeded/u);
    expect(() => assertBytesReceivedBudget(megabyteDump)).toThrow(/budget exceeded/u);
    expect(bytesReceivedCeiling(sample.budget)).toBeLessThan(1_000_000);
  });

  it.each(boundaryTimingFixtures)(
    "reports normalized compiler IPC timing for $fixture through the public seam",
    async (definition) => {
      const inputPath = fixtureInputPath(definition);
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* ProjectExtractor;
            const timing = yield* InternalProjectExtractorTiming;
            return yield* timing.extractModule(inputPath);
          }).pipe(Effect.provide(timedProjectExtractorLayer({ tsconfigPath })))
        )
      );

      expect(result.result).not.toHaveProperty("timing");
      expect(result.timing.enabled).toBe(true);
      expect(result.timing.totals.requestCount).toBeGreaterThan(0);
      expect(result.timing.totals.roundTripMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(result.timing.totals.bytesSent)).toBe(true);
      expect(Number.isFinite(result.timing.totals.bytesReceived)).toBe(true);
      expect(result.timing.totals.bytesSent).toBeGreaterThanOrEqual(0);
      expect(result.timing.totals.bytesReceived).toBeGreaterThanOrEqual(0);
      expect(result.timing.recentRequests.length).toBeGreaterThan(0);
      expect(result.timing.recentRequests.every((request) => request.roundTripMs >= 0)).toBe(true);
    }
  );
});
