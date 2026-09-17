/** Stable identity strings shared by the Issue 14 evidence producers and validators. */
export const issue14ConformanceCommand = "node scripts/conformance/report.ts --check" as const;
/** The Issue 14 timing command the stored evidence records. */
export const issue14TimingCommand = "node scripts/timing.ts --plan issue14 --check" as const;
/** The compiler identity the Issue 14 evidence requires. */
export const issue14CompilerVersion = "typescript@7.0.2" as const;
/** The durable timing contract: semantic counters must match exactly. */
export const issue14TimingStableContract = "semantic-counters-exact" as const;
/** The wall-clock timing contract: durations are recorded observations, not gates. */
export const issue14TimingWallClockContract = "observational" as const;
/** Why wall-clock fields are observational while semantic counters stay exact. */
export const issue14TimingWallClockRationale =
  "wall-clock IPC fields vary with scheduler and process load and are recorded as observations only; semantic counters stay exact; transport byte counts vary with checkout paths and are gated by catalog ceilings that carry path-length headroom" as const;
/** Recorded evidence for the backend-leakage stop condition. */
export const issue14BackendLeakageEvidence =
  "check-boundary.ts verifies unstable TypeScript imports remain inside src/backend/ts7/**" as const;
/** Recorded evidence for the durable-contract-leakage stop condition. */
export const issue14DurableContractLeakageEvidence =
  "package-owned model, warnings, provenance, and ProjectExtractor expose no compiler objects" as const;
/** The IPC growth threshold: aggregate counters must stay within the summed catalog ceilings. */
export const issue14IpcThreshold =
  "aggregate requestCount and bytesReceived <= the sum of the catalog ceilings for the four fixtures" as const;
/** How the aggregate IPC stop condition is measured and checked. */
export const issue14IpcEvidence =
  "each fixture runs in a fresh public-seam timing session like the Issue 02 baseline; semantic counters are exact, wall-clock fields are observational, and the live and stored aggregate request count and bytes received are checked against the catalog ceilings" as const;

/**
 * The oracle file a conformance fixture's extraction is compared against: the reviewed TS7
 * oracle for a reviewed divergence, otherwise the immutable upstream oracle.
 */
export function issue14SelectedOracleFile(
  definition: ConformanceFixture
): "output.json" | "output.tsgo.json" {
  return definition.disposition === "reviewed-ts7" ? "output.tsgo.json" : "output.json";
}

// The typecheck runner owns both the reproducible command string and the
// compiler argv used to execute it. Re-exporting keeps all evidence consumers
// on that single owner without making the contract module another source of
// command drift.
export { issue14TypecheckCommand, issue14TypecheckStrategy } from "./typecheck.ts";
import type { ConformanceFixture } from "../fixture-plans.ts";
