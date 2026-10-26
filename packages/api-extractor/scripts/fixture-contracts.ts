/**
 * What one fixture's evidence is, independent of how the catalog finds it.
 *
 * The derivation module reads the fixture tree; these are the records it
 * produces and the hand-maintained budgets it merges in. They live apart so
 * the derivation stays a page of rules and the contract stays readable on its
 * own.
 */

/** The compiler package current evidence is produced with: tsrs, a Rust port of TypeScript 7. */
export const pinnedTypeScript7Compiler = "tsrs@0.18.0-ts7.1.0-dev.20260929" as const;

/** The microsoft/TypeScript version the pinned compiler ports; its semantics are TypeScript 7.1's. */
export const pinnedTypeScriptVersion = "7.1.0-dev.20260929" as const;

/**
 * The compiler that recorded evidence before the move to tsrs.
 *
 * The immutable Issue 02 baseline in `test/fixtures/timing-boundary.json` names it forever, and a
 * reviewed divergence record names it until `--write-ts7` refreshes that record. Checks still
 * reproduce every such record with the pinned compiler.
 */
export const previousTypeScript7Compiler = "typescript@7.0.2" as const;

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

type BoundaryBudget = Omit<BoundaryTimingMetadata, "plan" | "order"> & { readonly fixture: string };
type ExternalSelectionBudget = Omit<ExternalSelectionTimingMetadata, "plan" | "order"> & {
  readonly fixture: string;
};

export type FixtureBudgets = {
  readonly timing: {
    readonly boundary: readonly BoundaryBudget[];
    readonly externalSelection: readonly ExternalSelectionBudget[];
    /** Why the bytes-received ceilings have their current size; bytes vary with protocol and path. */
    readonly bytesReceivedReason: string;
  };
  readonly virtualUpstreamDependency: readonly string[];
  readonly locallyGeneratedOracles: readonly string[];
  readonly excludedTypecheckProjects: readonly string[];
  /**
   * Projects whose immutable inputs report diagnostics under the pinned compiler. The gate still
   * compiles them and requires exactly these lines, so any other diagnostic fails it.
   */
  readonly expectedTypecheckDiagnostics: readonly {
    readonly project: string;
    readonly reason: string;
    readonly diagnostics: readonly [string, ...string[]];
  }[];
};
