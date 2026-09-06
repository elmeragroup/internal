import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type {
  BackendCompilerOperations,
  BackendSignatureFacts,
  BackendTypeNodeHandle,
} from "../src/backend/contracts.ts";
import { openTsgoProject } from "../src/backend/ts7/project.ts";
import { defaultExtractorOptions } from "../src/options.ts";
import { recoverAuthoredComponent } from "../src/parse/component-authorship.ts";
import type { ResolverContext } from "../src/parse/contracts.ts";
import { normalizeExternalTypeSelection } from "../src/parse/external-type-selection.ts";
import { extractFixture } from "./support/extract.ts";

const fixtureDirectory = resolve(import.meta.dirname, "fixtures/component-authorship");
const tsconfigPath = resolve(fixtureDirectory, "tsconfig.json");
const inputPath = resolve(fixtureDirectory, "input.tsx");

function authorshipContext(operations: BackendCompilerOperations): ResolverContext {
  return {
    operations,
    filePath: inputPath,
    warnings: [],
    provenance: [],
    provenancePath: [],
    provenancePropertyContainer: "object",
    symbolStack: ["TripleWrapped"],
    options: {
      shouldResolveObject: defaultExtractorOptions.shouldResolveObject,
    },
    externalTypes: normalizeExternalTypeSelection(false),
    substitutions: new Map(),
    active: new Set(),
    propertyDepth: 0,
    pureTypeExport: false,
    authoredIntersectionMember: false,
  };
}

function withoutDeclaration(facts: BackendSignatureFacts): BackendSignatureFacts {
  if (facts.declaration === undefined) return facts;
  if (facts.returnType === undefined) {
    return { parameters: facts.parameters, typeParameters: facts.typeParameters };
  }
  return {
    parameters: facts.parameters,
    typeParameters: facts.typeParameters,
    returnType: facts.returnType,
  };
}

function omitFirstDeclarationWhenCompressed(compiler: BackendCompilerOperations): BackendCompilerOperations {
  let remaining = 3;
  return {
    ...compiler,
    signatureFacts: (signature) => {
      const facts = compiler.signatureFacts(signature);
      if (remaining <= 0 || facts.declaration === undefined) return facts;
      remaining -= 1;
      return remaining === 2 ? withoutDeclaration(facts) : facts;
    },
  };
}

function propsTypeText(
  operations: BackendCompilerOperations,
  propsType: BackendTypeNodeHandle | undefined
): string {
  if (propsType === undefined) throw new Error("Missing authored props type node");
  return operations.nodeFacts(propsType).text;
}

describe("component authorship signature zip", () => {
  it("keeps each wrapper overload's first parameter when an earlier signature has no declaration", async () => {
    const extracted = await extractFixture({ tsconfigPath }, inputPath);
    const component = extracted.module.exports.find((entry) => entry.name === "TripleWrapped")?.type;
    expect(component).toMatchObject({
      kind: "component",
      props: [
        { name: "text", optional: true },
        { name: "count", optional: true },
        { name: "flag", optional: true },
      ],
    });

    const project = openTsgoProject({ tsconfigPath });
    try {
      const session = project.openExtraction();
      const symbol = session
        .readModule(inputPath)
        .exports.find((entry) => entry.name === "TripleWrapped")?.symbol;
      if (symbol === undefined) throw new Error("Missing TripleWrapped export");
      const compiler = session.compiler;
      const baseline = recoverAuthoredComponent(symbol, authorshipContext(compiler));
      expect(baseline.parameters.map((entry) => propsTypeText(compiler, entry.propsType))).toEqual([
        "TextProps",
        "CountProps",
        "FlagProps",
      ]);

      const compressed = omitFirstDeclarationWhenCompressed(compiler);
      const recovered = recoverAuthoredComponent(symbol, authorshipContext(compressed));
      expect(recovered.parameters.map((entry) => entry.parameter.id)).toEqual(
        baseline.parameters.map((entry) => entry.parameter.id)
      );
      expect(recovered.parameters.map((entry) => propsTypeText(compressed, entry.propsType))).toEqual([
        "TextProps",
        "CountProps",
        "FlagProps",
      ]);
      session.close();
    } finally {
      project.close();
    }
  });
});
