/**
 * What one fixture's evidence is, independent of how the catalog finds it.
 *
 * The derivation module reads the fixture tree; these are the records it
 * produces and the hand-maintained budgets it merges in. They live apart so
 * the derivation stays a page of rules and the contract stays readable on its
 * own.
 */

export const pinnedTypeScript7Compiler = "typescript@7.0.2" as const;

export type OracleDisposition = "immutable-upstream" | "reviewed-divergence" | "generated" | "not-applicable";
export type ConformanceDisposition = "unchanged" | "reviewed-ts7";
export type TypecheckStrategy = "direct-input" | "virtual-upstream-dependency" | "not-applicable";
/**
 * The three timing plans, by their stored ids.
 *
 * `issue02` and `issue14` keep their ticket-era ids deliberately: the
 * immutable baseline in `test/fixtures/timing-boundary.json` records the
 * command that produced it, and that identity is part of the evidence. Every
 * name around them says what the plan measures — the boundary plan and the
 * conformance plan.
 */
export type TimingPlan = "externalSelection" | "issue02" | "issue14";

export type TimingMetadata =
  | {
      readonly plan: "issue02";
      readonly order: number;
      readonly maxFetchedToMaterializedRatio: number;
      readonly maxRequestCount: number;
      readonly maxBytesReceived: number;
      readonly bytesReceivedPathLengthHeadroom?: number;
    }
  | { readonly plan: "issue14"; readonly order: number }
  | {
      readonly plan: "externalSelection";
      readonly order: number;
      readonly maxRequestCount: number;
      readonly maxBytesReceived: number;
    };

export type BoundaryTimingMetadata = Extract<TimingMetadata, { readonly plan: "issue02" }>;
export type ConformanceTimingMetadata = Extract<TimingMetadata, { readonly plan: "issue14" }>;
export type ExternalSelectionTimingMetadata = Extract<TimingMetadata, { readonly plan: "externalSelection" }>;

export type FixtureEvidenceRecord = {
  readonly id: string;
  readonly input: { readonly id: string; readonly file: string };
  readonly conformance: { readonly evidenceId: string; readonly disposition: ConformanceDisposition } | false;
  readonly typecheck: { readonly strategy: TypecheckStrategy };
  readonly timing: readonly TimingMetadata[];
  readonly warnings: {
    readonly oracleFile: "warnings.tsgo.json" | null;
    readonly codes: readonly string[];
  };
  readonly oracle: {
    readonly disposition: OracleDisposition;
    readonly upstreamFile: "output.json" | null;
    readonly selectedFile: "output.json" | "output.tsgo.json" | null;
    readonly divergenceRecord: "ts7-oracle.json" | null;
  };
  readonly evidence: {
    readonly id: string;
    readonly origin: "pinned-upstream" | "local-regression";
    readonly compiler: typeof pinnedTypeScript7Compiler;
  };
};

/** Path-length slack for the boundary plan's small bytes-received budgets. */
export const boundaryBytesReceivedPathLengthHeadroom = 32_768;

type BoundaryBudget = Omit<BoundaryTimingMetadata, "plan" | "order"> & { readonly fixture: string };
type ExternalSelectionBudget = Omit<ExternalSelectionTimingMetadata, "plan" | "order"> & {
  readonly fixture: string;
};

export type FixtureBudgets = {
  readonly timing: {
    readonly boundary: readonly BoundaryBudget[];
    readonly externalSelection: readonly ExternalSelectionBudget[];
  };
  readonly virtualUpstreamDependency: readonly string[];
  readonly locallyGeneratedOracles: readonly string[];
  readonly excludedTypecheckProjects: readonly string[];
};
