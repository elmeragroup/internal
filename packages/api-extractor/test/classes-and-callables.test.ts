import { resolve } from "node:path";
import { describe, expect, it, beforeAll } from "vitest";

import type { ExtractionResult, ExtractorOptions } from "../src/index.ts";
import type { ClassMethod, ClassProperty, SemanticType } from "../src/model.ts";
import { extractFixture, fixtureRoot } from "./support/extract.ts";

const tsconfigPath = resolve(fixtureRoot, "classes-and-callables-tsconfig.json");

describe("classes and callables on the ported upstream fixtures", () => {
  it("reports the construct signatures a non-class shape carries as structured warnings", async () => {
    const result = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "class-members-visibility-and-signatures", "input.ts")
    );
    const expected = [
      {
        code: "unrepresented-construct-signatures",
        structuralPath: ["Constructable", "constructSignatures"],
        signatureCount: 1,
      },
      {
        code: "unrepresented-construct-signatures",
        structuralPath: ["ConstructableType", "constructSignatures"],
        signatureCount: 1,
      },
    ];
    const actual = result.warnings
      .filter((warning) => warning.code === "unrepresented-construct-signatures")
      .map((warning) => ({
        code: warning.code,
        structuralPath: [...warning.structuralPath],
        signatureCount: warning.signatureCount,
      }));
    expect(actual).toEqual(expected);
  });

  it("degrades the indexed-access parameter of a generic method to a silent any", async () => {
    // Issue 06 pinned an `unsupported-type-fallback` warning here because the
    // resolver had no representation for `T[K]` under unresolved parameters.
    // Issue 09's index-like fallback mirrors upstream's `resolveIndexLikeType`
    // — expand the base constraint when one exists, otherwise report `any`
    // silently, "an expected limitation rather than a parser bug" — so the
    // model still matches the immutable oracle and the extra warning is gone.
    const result = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "class-method-generic-signatures", "input.ts")
    );
    expect(
      result.warnings.filter(
        (warning) =>
          warning.code === "unsupported-type-fallback" &&
          warning.parsedSymbolStack.at(-2) === "Repository" &&
          warning.parsedSymbolStack.at(-1) === "parameter: value"
      )
    ).toHaveLength(0);
    const repository = result.module.exports.find((entry) => entry.name === "Repository");
    if (repository === undefined) throw new Error("The fixture does not export Repository");
    if (repository.type.kind !== "class") {
      throw new Error(`Repository is a ${repository.type.kind}, not a class`);
    }
    const signature = repository.type.methods[0]?.callSignatures[0];
    const value = signature?.parameters.find((parameter) => parameter.name === "value");
    expect(value?.type).toEqual({ kind: "intrinsic", intrinsic: "any" });
  });

  it("resolves the callable-intersection React payloads as upstream does", async () => {
    // The fixture's own comment says upstream disregards the extra properties
    // of `Callable & ExtraData`; its React-side union arms (anonymous
    // construct-only members of `JSXElementConstructor`) are likewise reported
    // by upstream as bare objects rather than unsupported-type fallbacks, so
    // the module stays byte-identical to the immutable oracle with no
    // recoverable warnings at all.
    const result = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "function-callable-intersection-extra-properties", "input.tsx")
    );
    expect(result.warnings.map((warning) => warning.code)).toEqual([]);
  });

  it("emits no warnings for the overload and re-export ports", async () => {
    for (const [fixture, file] of [
      ["class-method-overload-signatures", "input.ts"],
      ["class-private-members-type-alias-filtering", "input.ts"],
      ["function-declaration-expression-arrow", "input.ts"],
      ["jsdoc-comments-and-overloads", "input.tsx"],
      ["merged-interface-signature-typeparams", "input.ts"],
      ["module-reexport-imported-class-type", "input.ts"],
    ] as const) {
      const result = await extractFixture({ tsconfigPath }, resolve(fixtureRoot, fixture, file));
      expect(result.warnings).toEqual([]);
    }
  });
});

const fixtureDirectory = resolve(import.meta.dirname, "fixtures/class-and-callable-members");

function extract(options: ExtractorOptions = {}, file = "input.ts"): Promise<ExtractionResult> {
  return extractFixture(
    { tsconfigPath: resolve(fixtureDirectory, "tsconfig.json") },
    resolve(fixtureDirectory, file),
    options
  );
}

let result: ExtractionResult;

beforeAll(async () => {
  result = await extract();
});

function exportedType(name: string): SemanticType {
  const entry = result.module.exports.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`The fixture does not export ${name}`);
  return entry.type;
}

function classMember(name: string): Extract<SemanticType, { kind: "class" }> {
  const type = exportedType(name);
  if (type.kind !== "class") throw new Error(`${name} is a ${type.kind}, not a class`);
  return type;
}

function method(owner: string, name: string): ClassMethod {
  const type = classMember(owner);
  const found = type.methods.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`${owner} has no method ${name}`);
  return found;
}

function property(owner: string, name: string): ClassProperty {
  const type = classMember(owner);
  const found = type.properties.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`${owner} has no property ${name}`);
  return found;
}

describe("class and callable review regressions", () => {
  it("extracts an exported class with constructors, members, and type parameters", () => {
    const derived = classMember("DerivedShape");
    expect(derived.typeName).toEqual({ name: "DerivedShape" });
    expect(derived.typeParameters).toEqual([{ name: "T" }]);
    expect(derived.constructSignatures).toHaveLength(1);
    expect(derived.constructSignatures[0]).toEqual({ parameters: [] });
    // Instance properties first (own, then inherited), the getter included;
    // `add` and the inherited `describe` are instance methods, and the static
    // `create`/`fromName` follow them.
    expect(derived.properties.map((entry) => entry.name)).toEqual(["units", "size", "name"]);
    expect(derived.methods.map((entry) => entry.name)).toEqual(["add", "describe", "create", "fromName"]);
  });

  it("inherits public base members through the checker and drops private and protected ones", () => {
    const derived = classMember("DerivedShape");
    // Inherited from BaseShape; the private audit trail and protected seed
    // never reach either side.
    expect(derived.properties.map((entry) => entry.name)).toContain("name");
    expect(derived.methods.map((entry) => entry.name)).toContain("describe");
    expect(JSON.stringify(derived)).not.toContain("auditTrail");
    expect(JSON.stringify(derived)).not.toContain("sharedSeed");
    const base = JSON.stringify(classMember("BaseShape"));
    expect(base).not.toContain("auditTrail");
    expect(base).not.toContain("sharedSeed");
  });

  it("keeps static members on the static half with built-in function statics skipped", () => {
    const derived = classMember("DerivedShape");
    const create = method("DerivedShape", "create");
    expect(create.isStatic).toBe(true);
    const units = property("DerivedShape", "units");
    expect(units.isStatic).toBe(false);
    // `name` is a legitimate inherited member here; only the Function builtins
    // that carry no authored member are skipped.
    for (const builtIn of ["prototype", "length", "arguments", "caller"]) {
      expect(derived.properties.map((entry) => entry.name)).not.toContain(builtIn);
    }
  });

  it("marks getter-only accessors readonly while methods stay methods", () => {
    const size = property("DerivedShape", "size");
    expect(size.readonly).toBe(true);
    expect(size.optional).toBe(false);
    const add = method("DerivedShape", "add");
    expect(add.callSignatures[0]?.parameters[0]?.type).toMatchObject({ kind: "typeParameter", name: "T" });
  });

  it("records provenance paths alongside class members and signature parameters", () => {
    // The stable sidecar paths are what let callers attribute a parameter or
    // member back to its declaration; assert they exist at those paths.
    const provenancePaths = result.provenance.map((entry) => entry.path.join("/"));
    expect(provenancePaths).toContain("BaseShape/properties/name");
    expect(provenancePaths).toContain("DerivedShape/methods/add/callSignatures/0/parameters/unit");
    expect(provenancePaths).toContain("DerivedShape/properties/units");
  });

  it("extracts a callable interface as its call signatures and reports the dropped members", () => {
    const counter = exportedType("makeCounter");
    expect(counter.kind).toBe("function");
    if (counter.kind !== "function") return;
    expect(counter.callSignatures[0]?.parameters[0]?.type).toMatchObject({
      kind: "intrinsic",
      intrinsic: "number",
    });
    // Both the value and the interface it is typed as lose `step` and `reset`
    // to the callable half; each loss is reported at its own structural path.
    const warnings = result.warnings
      .filter((warning) => warning.code === "omitted-callable-members")
      .map((warning) => ({
        structuralPath: warning.structuralPath.join("/"),
        memberNames: [...warning.memberNames].sort(),
      }))
      .sort((left, right) => left.structuralPath.localeCompare(right.structuralPath));
    expect(warnings).toEqual([
      { structuralPath: "Counter", memberNames: ["reset", "step"] },
      { structuralPath: "makeCounter", memberNames: ["reset", "step"] },
    ]);
  });

  it("reports the construct signatures of non-class shapes with their structural path", () => {
    const point = exportedType("ConstructablePoint");
    // Upstream reports such shapes as bare objects; so does the model.
    expect(point).toMatchObject({ kind: "object" });
    const warning = result.warnings.find(
      (candidate) =>
        candidate.code === "unrepresented-construct-signatures" &&
        candidate.structuralPath.join("/") === "ConstructablePoint/constructSignatures"
    );
    if (warning?.code !== "unrepresented-construct-signatures") {
      throw new Error("The unrepresented-construct-signatures warning is missing");
    }
    expect(warning.signatureCount).toBe(1);
    expect(warning.message).toContain("ConstructablePoint/constructSignatures");
  });

  it("preserves materially different overloads in source order without collapsing them", () => {
    const parseValue = exportedType("parseValue");
    if (parseValue.kind !== "function") throw new Error("parseValue is not a function");
    expect(parseValue.callSignatures).toHaveLength(2);
    const first = parseValue.callSignatures[0];
    const second = parseValue.callSignatures[1];
    if (first === undefined || second === undefined) throw new Error("An overload is missing");
    expect(first.parameters[0]?.type).toMatchObject({ kind: "intrinsic", intrinsic: "string" });
    expect(first.returnValueType).toMatchObject({ kind: "intrinsic", intrinsic: "number" });
    expect(second.parameters).toHaveLength(2);
    expect(second.returnValueType).toMatchObject({ kind: "intrinsic", intrinsic: "string" });
  });

  it("keeps optional and rest parameters with their optionality and types", () => {
    const emit = exportedType("emit");
    if (emit.kind !== "function") throw new Error("emit is not a function");
    const signature = emit.callSignatures[0];
    if (signature === undefined) throw new Error("emit has no call signature");
    const [event, detail, rest] = signature.parameters;
    expect(event?.optional).toBe(false);
    expect(detail?.optional).toBe(true);
    expect(rest?.type).toMatchObject({
      kind: "array",
      elementType: { kind: "intrinsic", intrinsic: "boolean" },
    });
    expect(signature.returnValueType).toMatchObject({ kind: "intrinsic", intrinsic: "void" });
  });

  it("filters private members reached through a type alias to a non-exported class", () => {
    // Mirrors the ported upstream fixture at the member level: object
    // resolution of the aliased instance side keeps the public state and never
    // reports the private field.
    const registry = exportedType("RegistryAlias");
    expect(registry).toMatchObject({ kind: "object" });
    if (registry.kind !== "object") return;
    expect(registry.properties.map((entry) => entry.name)).toEqual(["open"]);
    expect(JSON.stringify(registry)).not.toContain("secrets");
  });

  it("reports construct signatures a callable-first shape drops beside its call signatures", () => {
    // A shape with BOTH call and construct signatures resolves as a function,
    // and only a class would have been resolved through its construct side, so
    // the construct half is reported at its structural path instead of
    // vanishing silently.
    const callable = exportedType("CallableAndConstructable");
    expect(callable.kind).toBe("function");
    if (callable.kind !== "function") return;
    expect(callable.callSignatures[0]?.parameters[0]?.type).toMatchObject({
      kind: "intrinsic",
      intrinsic: "number",
    });
    const warning = result.warnings.find(
      (candidate) =>
        candidate.code === "unrepresented-construct-signatures" &&
        candidate.structuralPath.join("/") === "CallableAndConstructable/constructSignatures"
    );
    if (warning?.code !== "unrepresented-construct-signatures") {
      throw new Error("The unrepresented-construct-signatures warning is missing");
    }
    expect(warning.signatureCount).toBe(1);
    expect(warning.message).toContain("CallableAndConstructable/constructSignatures");
  });

  it("classifies an interface-merged member written as a method signature as a method", () => {
    // Declaration merging hands the class instance side the interface's method
    // signature; it must appear as a method with its call signature, not as a
    // function-typed property.
    const merged = classMember("MergedCounter");
    expect(method("MergedCounter", "tick").callSignatures).toHaveLength(1);
    expect(method("MergedCounter", "tick").isStatic).toBe(false);
    expect(merged.properties.map((entry) => entry.name)).toEqual(["value"]);
  });

  it("produces deterministic output across repeated extractions", async () => {
    const again = await extract();
    expect(JSON.stringify(again.module)).toBe(JSON.stringify(result.module));
    expect(JSON.stringify(again.warnings)).toBe(JSON.stringify(result.warnings));
  });
});
