import { resolve } from "node:path";

import {
  assertBytesReceivedCeiling,
  assertRequestCountCeiling,
  externalSelectionTimingFixtures,
  fixtureDirectory,
} from "../fixture-evidence.ts";
import { timedExtraction } from "./shared.ts";

const selectedPackage = "@fixture/selected";

/** Checks the one catalog-owned selective external-type fixture against its request plateau. */
export async function runExternalSelectionTiming(): Promise<void> {
  const [fixtureDefinition, ...unexpectedFixtures] = externalSelectionTimingFixtures;
  if (fixtureDefinition === undefined || unexpectedFixtures.length > 0) {
    throw new Error("Expected one catalog-owned external-selection timing fixture.");
  }
  const fixtureRoot = resolve(fixtureDirectory, fixtureDefinition.fixture);
  const extraction = await timedExtraction(
    resolve(fixtureRoot, "tsconfig.json"),
    resolve(fixtureRoot, fixtureDefinition.file),
    { includeExternalTypes: [selectedPackage] }
  );
  const component = extraction.result.module.exports.find(
    (candidate) => candidate.name === "PrimitiveComponent"
  );
  if (component?.type.kind !== "component") {
    throw new Error("The representative selective-expansion component was not recognized.");
  }
  const props = new Map(component.type.props.map((property) => [property.name, property]));
  if (props.has("prefixedPackageProp")) {
    throw new Error("Selective expansion entered an unselected same-prefix package.");
  }
  if (props.get("foreignDetail")?.type.kind !== "external") {
    throw new Error("Selective expansion entered an unselected dependency graph.");
  }
  const actionType = props.get("onAction")?.type;
  if (actionType?.kind !== "union" || actionType.types[0]?.kind !== "external") {
    throw new Error("Selective expansion entered the React or DOM graph.");
  }
  if (!extraction.timing.enabled) throw new Error("Selective-expansion timing evidence is disabled.");
  // Wall-clock fields are recorded observations; only the deterministic counters gate.
  assertRequestCountCeiling({
    fixture: fixtureDefinition.fixture,
    requestCount: extraction.timing.totals.requestCount,
    maxRequestCount: fixtureDefinition.maxRequestCount,
  });
  assertBytesReceivedCeiling({
    fixture: fixtureDefinition.fixture,
    bytesReceived: extraction.timing.totals.bytesReceived,
    maxBytesReceived: fixtureDefinition.maxBytesReceived,
  });
  console.log(
    JSON.stringify({
      fixture: fixtureDefinition.fixture,
      selectedPackage,
      roundTripMs: extraction.timing.totals.roundTripMs,
      requestCount: extraction.timing.totals.requestCount,
      maxRequestCount: fixtureDefinition.maxRequestCount,
      bytesReceived: extraction.timing.totals.bytesReceived,
      maxBytesReceived: fixtureDefinition.maxBytesReceived,
      props: [...props.keys()],
    })
  );
}
