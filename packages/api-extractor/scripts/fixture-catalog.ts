import { Schema } from "effect";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import type {
  FixtureBudgets,
  FixtureEvidenceRecord,
  OracleDisposition,
  TimingMetadata,
  TypecheckStrategy,
} from "./fixture-contracts.ts";
import { pinnedTypeScript7Compiler } from "./fixture-contracts.ts";

export * from "./fixture-contracts.ts";

/**
 * The fixture inventory, derived from the fixture tree.
 *
 * Adding a fixture is creating its directory: a directory under
 * `test/fixtures` holding an `input.*` file is a fixture, `output.json` makes
 * it a conformance fixture, `output.tsgo.json` makes that a reviewed
 * TypeScript 7 divergence, `ts7-oracle.json` is the divergence record, and
 * `warnings.tsgo.json` supplies the warning oracle and its code order. The
 * only hand-maintained facts are the ones no filename can state — IPC
 * ceilings, the one fixture type-checked through a virtual upstream
 * dependency, the two locally generated oracles, and the projects the
 * type-check plan skips — and they live in `test/fixtures/fixtures.json`.
 */

const fixtureRoot = resolve(import.meta.dirname, "..", "test", "fixtures");

const FixtureBudgetsSchema = Schema.Struct({
  timing: Schema.Struct({
    boundary: Schema.Array(
      Schema.Struct({
        fixture: Schema.String,
        maxFetchedToMaterializedRatio: Schema.Number,
        maxRequestCount: Schema.Number,
        maxBytesReceived: Schema.Number,
        bytesReceivedPathLengthHeadroom: Schema.optionalKey(Schema.Number),
      })
    ),
    externalSelection: Schema.Array(
      Schema.Struct({
        fixture: Schema.String,
        maxRequestCount: Schema.Number,
        maxBytesReceived: Schema.Number,
      })
    ),
  }),
  virtualUpstreamDependency: Schema.Array(Schema.String),
  locallyGeneratedOracles: Schema.Array(Schema.String),
  excludedTypecheckProjects: Schema.Array(Schema.String),
});

/** A warning oracle is the reviewed warning list, in the order the extractor reports it. */
const WarningOracleSchema = Schema.Array(Schema.Struct({ code: Schema.String }));

function readJson(path: string): Schema.Json {
  return Schema.decodeUnknownSync(Schema.Json)(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * Reads and decodes the hand-maintained fixture facts (`fixtures.json`): IPC ceilings and the
 * recorded per-fixture exceptions no filename can state.
 *
 * @param root - The fixture root directory.
 * @returns The decoded budgets.
 * @throws When the file is unreadable or does not match the schema.
 */
export function readFixtureBudgets(root: string): FixtureBudgets {
  return Schema.decodeUnknownSync(FixtureBudgetsSchema)(readJson(join(root, "fixtures.json")));
}

/** The warning codes a fixture's oracle records, in oracle order. */
function warningCodes(path: string): readonly string[] {
  return Schema.decodeUnknownSync(WarningOracleSchema)(readJson(path)).map((entry) => entry.code);
}

function timingOf(budgets: FixtureBudgets, id: string): readonly TimingMetadata[] {
  const order = budgets.timing.boundary.findIndex((entry) => entry.fixture === id);
  const boundary = budgets.timing.boundary[order];
  if (boundary !== undefined) {
    const { fixture: _fixture, ...ceilings } = boundary;
    return [
      { plan: "issue02", order, ...ceilings },
      { plan: "issue14", order },
    ];
  }
  const selectionOrder = budgets.timing.externalSelection.findIndex((entry) => entry.fixture === id);
  const selection = budgets.timing.externalSelection[selectionOrder];
  if (selection === undefined) return [];
  const { fixture: _fixture, ...ceilings } = selection;
  return [{ plan: "externalSelection", order: selectionOrder, ...ceilings }];
}

/** Every fixture directory: the directories under the root holding an `input.*` file. */
export function fixtureDirectories(root: string): readonly { readonly id: string; readonly file: string }[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const inputs = readdirSync(join(root, entry.name))
        .filter((name) => name.startsWith("input."))
        .sort();
      if (inputs.length > 1) {
        throw new Error(`Fixture ${entry.name} has more than one input.* file: ${inputs.join(", ")}`);
      }
      const file = inputs[0];
      return file === undefined ? [] : [{ id: entry.name, file }];
    })
    .sort((left, right) => (left.id < right.id ? -1 : 1));
}

/**
 * Derives the complete fixture catalog from the fixture tree: one evidence record per
 * directory holding an `input.*` file, classified by the oracle files it contains and the
 * budgets keyed by fixture id.
 *
 * @param root - The fixture root directory.
 * @param budgets - The hand-maintained facts from `fixtures.json`.
 * @returns Records ordered by fixture id.
 * @throws When a fixture directory holds more than one input file, a derived record violates the
 *   evidence contract, or a budget names a missing fixture or type-check project.
 */
export function deriveFixtureCatalog(
  root: string,
  budgets: FixtureBudgets
): readonly FixtureEvidenceRecord[] {
  const records: FixtureEvidenceRecord[] = fixtureDirectories(root).map(({ id, file }) => {
    const contents = readdirSync(join(root, id));
    const locallyGenerated = budgets.locallyGeneratedOracles.includes(id);
    const upstream = contents.includes("output.json") && !locallyGenerated;
    const reviewed = upstream && contents.includes("output.tsgo.json");
    const warningOracle = contents.includes("warnings.tsgo.json");
    const evidenceId = `${id}/${upstream ? "conformance" : "regression"}`;
    const strategy: TypecheckStrategy = !upstream
      ? "not-applicable"
      : budgets.virtualUpstreamDependency.includes(id)
        ? "virtual-upstream-dependency"
        : "direct-input";
    const disposition: OracleDisposition = reviewed
      ? "reviewed-divergence"
      : upstream
        ? "immutable-upstream"
        : locallyGenerated
          ? "generated"
          : "not-applicable";
    return {
      id,
      input: { id: `${id}/${file}`, file },
      conformance: upstream ? { evidenceId, disposition: reviewed ? "reviewed-ts7" : "unchanged" } : false,
      typecheck: { strategy },
      timing: timingOf(budgets, id),
      warnings: {
        oracleFile: warningOracle ? "warnings.tsgo.json" : null,
        codes: warningOracle ? warningCodes(join(root, id, "warnings.tsgo.json")) : [],
      },
      oracle: {
        disposition,
        upstreamFile: upstream ? "output.json" : null,
        selectedFile: reviewed ? "output.tsgo.json" : upstream ? "output.json" : null,
        divergenceRecord: reviewed && contents.includes("ts7-oracle.json") ? "ts7-oracle.json" : null,
      },
      evidence: {
        id: evidenceId,
        origin: upstream ? "pinned-upstream" : "local-regression",
        compiler: pinnedTypeScript7Compiler,
      },
    };
  });
  validateFixtureEvidenceCatalog(records);
  validateBudgetFixtures(records, root, budgets);
  return records;
}

/**
 * Cross-checks the hand-maintained `fixtures.json` budgets against the derived inventory, so a
 * rename or removal cannot silently drop a timing ceiling, a virtual dependency, a
 * generated-oracle exemption, or a type-check exclusion.
 *
 * @param records - The derived fixture records.
 * @param root - The fixture root directory.
 * @param budgets - The hand-maintained facts from `fixtures.json`.
 * @throws When a budget names a fixture that does not exist, or excludes a project that is not on disk.
 */
function validateBudgetFixtures(
  records: readonly FixtureEvidenceRecord[],
  root: string,
  budgets: FixtureBudgets
): void {
  const ids = new Set(records.map((record) => record.id));
  const groups = [
    ["timing.boundary", budgets.timing.boundary.map((entry) => entry.fixture)],
    ["timing.externalSelection", budgets.timing.externalSelection.map((entry) => entry.fixture)],
    ["virtualUpstreamDependency", budgets.virtualUpstreamDependency],
    ["locallyGeneratedOracles", budgets.locallyGeneratedOracles],
  ] as const;
  for (const [group, names] of groups) {
    for (const name of names) {
      if (!ids.has(name))
        throw new Error(`fixtures.json ${group} names a fixture that does not exist: ${name}`);
    }
  }
  for (const project of budgets.excludedTypecheckProjects) {
    if (!existsSync(join(root, project))) {
      throw new Error(`fixtures.json excludes a type-check project that does not exist: ${project}`);
    }
  }
}

/**
 * Checks a derived catalog against the invariants the gates rely on: stable ordering, valid
 * input ids, evidence ids that match the record's conformance class, compatible oracle
 * dispositions, a type-check strategy for every conformance fixture, a divergence record for
 * every reviewed divergence, and non-negative timing orders.
 *
 * @param catalog - The catalog to validate.
 * @throws When any invariant is violated.
 */
export function validateFixtureEvidenceCatalog(catalog: readonly FixtureEvidenceRecord[]): void {
  let previous = "";
  for (const record of catalog) {
    if (record.id <= previous) {
      throw new Error(`The catalog needs stable fixture-identity ordering: ${record.id} after ${previous}`);
    }
    previous = record.id;
    if (record.input.file.includes("/") || record.input.file.startsWith(".")) {
      throw new Error(`Fixture ${record.id} has an invalid fixture-local input file.`);
    }
    const evidenceId = `${record.id}/${record.conformance === false ? "regression" : "conformance"}`;
    if (record.evidence.id !== evidenceId) {
      throw new Error(`Fixture ${record.id} has missing conformance evidence: ${record.evidence.id}`);
    }
    if (record.conformance !== false && record.conformance.evidenceId !== evidenceId) {
      throw new Error(`Fixture ${record.id} has missing conformance evidence for its plan.`);
    }
    const reviewed = record.oracle.disposition === "reviewed-divergence";
    if (record.conformance !== false && (record.conformance.disposition === "reviewed-ts7") !== reviewed) {
      throw new Error(`Fixture ${record.id} has an incompatible oracle disposition.`);
    }
    if (record.conformance !== false && record.typecheck.strategy === "not-applicable") {
      throw new Error(`Conformance fixture ${record.id} is missing its type-check strategy.`);
    }
    if (record.oracle.disposition === "reviewed-divergence" && record.oracle.divergenceRecord === null) {
      throw new Error(`Fixture ${record.id} declares a divergence without its reason record.`);
    }
    if (record.warnings.oracleFile === null && record.warnings.codes.length > 0) {
      throw new Error(`Fixture ${record.id} has warning codes without a warning oracle.`);
    }
    for (const entry of record.timing) {
      if (!Number.isSafeInteger(entry.order) || entry.order < 0) {
        throw new Error(`Fixture ${record.id} has an invalid ${entry.plan} timing order.`);
      }
    }
  }
}

/** The fixture tree this package's own gates read. */
export const fixtureTreeRoot = fixtureRoot;

/** The decoded `test/fixtures/fixtures.json` facts for this package's own fixture tree. */
export const fixtureBudgets = readFixtureBudgets(fixtureRoot);
/**
 * The derived catalog for this package's own fixture tree. Derivation validates every record, so
 * an importer can never observe an invalid catalog.
 */
export const fixtureEvidenceCatalog = deriveFixtureCatalog(fixtureRoot, fixtureBudgets);
