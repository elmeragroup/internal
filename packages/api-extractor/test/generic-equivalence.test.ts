import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { CallSignatureNode, SemanticType } from "../src/model.ts";
import { extractFixture } from "./support/extract.ts";

const fixtureDirectory = resolve(import.meta.dirname, "fixtures/generic-equivalence");

function extract() {
  return extractFixture(
    { tsconfigPath: resolve(fixtureDirectory, "tsconfig.json") },
    resolve(fixtureDirectory, "input.ts")
  );
}

function exportType(module: Awaited<ReturnType<typeof extract>>["module"], name: string): SemanticType {
  const entry = module.exports.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`Missing export ${name}`);
  return entry.type;
}

function expectKind<K extends SemanticType["kind"]>(
  type: SemanticType,
  kind: K
): Extract<SemanticType, { kind: K }> {
  if (type.kind !== kind) throw new Error(`Expected a ${kind} node, received ${type.kind}`);
  // SAFETY: the guard above just verified the discriminant matches `kind`.
  return type as Extract<SemanticType, { kind: K }>;
}

function unionMembers(type: SemanticType): readonly SemanticType[] {
  return type.kind === "union" ? type.types : [type];
}

function firstSignature(type: SemanticType): CallSignatureNode {
  const signature = expectKind(type, "function").callSignatures[0];
  if (signature === undefined) throw new Error("Missing call signature");
  return signature;
}

function propertyType(type: SemanticType, name: string): SemanticType {
  const property = expectKind(type, "object").properties.find((entry) => entry.name === name);
  if (property === undefined) throw new Error(`Missing property ${name}`);
  return property.type;
}

function nestedObjectHandler(member: SemanticType): CallSignatureNode {
  const handler = firstSignature(member).parameters[0]?.type;
  if (handler === undefined) throw new Error("Missing handler parameter");
  return firstSignature(propertyType(handler, "fn"));
}

function declaredParameter(signature: CallSignatureNode, index: number) {
  const parameter = signature.typeParameters?.[index];
  if (parameter === undefined) throw new Error(`Missing type parameter ${String(index)}`);
  return parameter;
}

function at<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing ${label} ${String(index)}`);
  return value;
}

function parameterType(signature: CallSignatureNode, index: number): SemanticType {
  const parameter = signature.parameters[index];
  if (parameter === undefined) throw new Error(`Missing parameter ${String(index)}`);
  return parameter.type;
}

describe("native generic signature identity", () => {
  it("keeps nested string and number constraints as distinct callback members", async () => {
    const result = await extract();
    const exported = exportType(result.module, "DistinctNestedConstraints");
    expect(exported.kind).toBe("union");
    const members = unionMembers(exported);
    expect(members).toHaveLength(2);
    expect(declaredParameter(nestedObjectHandler(at(members, 0, "member")), 0).constraint).toEqual({
      kind: "intrinsic",
      intrinsic: "string",
    });
    expect(declaredParameter(nestedObjectHandler(at(members, 1, "member")), 0).constraint).toEqual({
      kind: "intrinsic",
      intrinsic: "number",
    });
    expect(result.warnings).toEqual([]);
  });

  it("keeps nested distinct generic defaults as distinct callback members", async () => {
    const result = await extract();
    const exported = exportType(result.module, "DistinctNestedDefaults");
    expect(exported.kind).toBe("union");
    const members = unionMembers(exported);
    expect(members).toHaveLength(2);
    const left = declaredParameter(nestedObjectHandler(at(members, 0, "member")), 0);
    const right = declaredParameter(nestedObjectHandler(at(members, 1, "member")), 0);
    const sharedConstraint = {
      kind: "union",
      types: [
        { kind: "intrinsic", intrinsic: "string" },
        { kind: "intrinsic", intrinsic: "number" },
      ],
    };
    expect(left.constraint).toEqual(sharedConstraint);
    expect(right.constraint).toEqual(sharedConstraint);
    expect(left.defaultValue).toEqual({ kind: "intrinsic", intrinsic: "string" });
    expect(right.defaultValue).toEqual({ kind: "intrinsic", intrinsic: "number" });
  });

  it("collapses alpha-renamed nested callbacks and equivalent inner shadowing", async () => {
    const result = await extract();
    // The checker still presents two authored members; canonicalization keeps one.
    const renamedType = exportType(result.module, "AlphaRenamedControls");
    expect(renamedType.kind).toBe("union");
    const renamed = unionMembers(renamedType);
    expect(renamed).toHaveLength(1);
    expect(declaredParameter(nestedObjectHandler(at(renamed, 0, "member")), 0)).toMatchObject({
      name: "T",
      constraint: { kind: "intrinsic", intrinsic: "string" },
    });

    const shadowedType = exportType(result.module, "EquivalentShadowing");
    expect(shadowedType.kind).toBe("union");
    const shadowed = unionMembers(shadowedType);
    expect(shadowed).toHaveLength(1);
    const outer = firstSignature(at(shadowed, 0, "member"));
    const inner = firstSignature(parameterType(outer, 0));
    expect(declaredParameter(outer, 0).name).toBe("T");
    expect(declaredParameter(inner, 0).name).toBe("T");
    expect(parameterType(inner, 0)).toMatchObject({ kind: "typeParameter", name: "T" });
  });

  it("keeps inner-versus-outer generic references as distinct members", async () => {
    const result = await extract();
    const exported = exportType(result.module, "InnerVersusOuter");
    expect(exported.kind).toBe("union");
    const members = unionMembers(exported);
    expect(members).toHaveLength(2);

    const innerBound = firstSignature(at(members, 0, "member"));
    const innerBoundNested = firstSignature(parameterType(innerBound, 0));
    expect(declaredParameter(innerBound, 0).name).toBe("T");
    expect(declaredParameter(innerBoundNested, 0).name).toBe("T");
    expect(parameterType(innerBoundNested, 0)).toMatchObject({ kind: "typeParameter", name: "T" });

    const outerBound = firstSignature(at(members, 1, "member"));
    const outerBoundNested = firstSignature(parameterType(outerBound, 0));
    expect(declaredParameter(outerBound, 0).name).toBe("U");
    expect(declaredParameter(outerBoundNested, 0).name).toBe("V");
    expect(parameterType(outerBoundNested, 0)).toMatchObject({ kind: "typeParameter", name: "U" });
  });
});
