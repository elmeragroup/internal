import { Effect } from "effect";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ProjectExtractor } from "../src/index.ts";
import type { ExtractWarning, ExtractionResult } from "../src/index.ts";
import { extractFixture } from "./support/extract.ts";
import { createTemporaryRoot } from "./support/temp-dirs.ts";

const candidateSource = `export interface ReactElement {
  readonly tag: string;
}
export function Card(props: { (): string; foo: string }): ReactElement {
  return { tag: props.foo };
}
declare function pick():
  ((props: { (): string; foo: string }) => ReactElement) | ((props: { (): string; bar: string }) => number);
export const Mixed = pick();
export function Factory(props: { (): string; foo: string }): string {
  return props.foo;
}
export function factory(props: { (): string; foo: string }): string {
  return props.foo;
}
`;

const retainedWarningKeys = [
  ["omitted-callable-members", ["Card", "callSignatures", "0", "parameters", "props"]],
  ["omitted-callable-members", ["Card"]],
  ["omitted-callable-members", ["Mixed", "callSignatures", "0", "parameters", "props"]],
  ["omitted-callable-members", ["Mixed", "callSignatures", "0", "parameters", "props"]],
  ["uncertain-component-recognition", "Mixed"],
  ["omitted-callable-members", ["Factory", "callSignatures", "0", "parameters", "props"]],
  ["omitted-callable-members", ["factory", "callSignatures", "0", "parameters", "props"]],
] as const;

async function withCandidateProject<T>(
  run: (paths: { tsconfigPath: string; inputPath: string }) => Promise<T>
): Promise<T> {
  const root = createTemporaryRoot("api-extractor-candidate-warnings-");
  try {
    const tsconfigPath = join(root, "tsconfig.json");
    const inputPath = join(root, "input.ts");
    writeFileSync(
      tsconfigPath,
      `${JSON.stringify(
        {
          compilerOptions: {
            module: "ESNext",
            moduleResolution: "Bundler",
            rootDir: ".",
            strict: true,
            target: "ES2022",
          },
          include: ["input.ts"],
        },
        null,
        2
      )}\n`
    );
    writeFileSync(inputPath, candidateSource);
    return await run({ tsconfigPath, inputPath });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function extractCandidate(): Promise<ExtractionResult> {
  return withCandidateProject(({ tsconfigPath, inputPath }) => extractFixture({ tsconfigPath }, inputPath));
}

function omittedCallableMembers(result: ExtractionResult, exportName: string) {
  return result.warnings
    .filter((warning) => warning.code === "omitted-callable-members")
    .filter((warning) => warning.structuralPath[0] === exportName);
}

function hasRootPathWarning(result: ExtractionResult, exportName: string): boolean {
  return omittedCallableMembers(result, exportName).some(
    (warning) => warning.structuralPath.join("/") === exportName
  );
}

function exportKind(result: ExtractionResult, name: string): string {
  const entry = result.module.exports.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`missing export ${name}`);
  return entry.type.kind;
}

function publishedWarningKey(warning: ExtractWarning): [ExtractWarning["code"], readonly string[] | string] {
  if ("structuralPath" in warning) return [warning.code, warning.structuralPath];
  if ("name" in warning) return [warning.code, warning.name];
  throw new Error(`warning ${warning.code} has neither structuralPath nor name`);
}

describe("discarded authored component-candidate warnings", () => {
  it("reports one parameter-path omitted-callable-members warning for Factory and factory", async () => {
    const result = await extractCandidate();
    const factoryWarnings = omittedCallableMembers(result, "Factory");
    expect(factoryWarnings).toHaveLength(1);
    const factoryWarning = factoryWarnings[0];
    if (factoryWarning === undefined) throw new Error("missing Factory omitted-callable-members warning");
    expect(factoryWarning.structuralPath.join("/")).toBe("Factory/callSignatures/0/parameters/props");
    expect([...factoryWarning.memberNames].sort((left, right) => left.localeCompare(right))).toEqual(["foo"]);
    const lowercaseWarnings = omittedCallableMembers(result, "factory");
    expect(lowercaseWarnings).toHaveLength(1);
    const lowercaseWarning = lowercaseWarnings[0];
    if (lowercaseWarning === undefined) throw new Error("missing factory omitted-callable-members warning");
    expect(lowercaseWarning.structuralPath.join("/")).toBe("factory/callSignatures/0/parameters/props");
    expect([...lowercaseWarning.memberNames].sort((left, right) => left.localeCompare(right))).toEqual([
      "foo",
    ]);
    expect(hasRootPathWarning(result, "Factory")).toBe(false);
    expect(hasRootPathWarning(result, "factory")).toBe(false);
  });

  it("keeps both omitted-callable-members warnings for a transformed Card component", async () => {
    const result = await extractCandidate();
    const cardWarnings = omittedCallableMembers(result, "Card");
    expect(cardWarnings.map((warning) => warning.structuralPath.join("/"))).toEqual([
      "Card/callSignatures/0/parameters/props",
      "Card",
    ]);
  });

  it("keeps Mixed as a union with uncertainty and two parameter-path warnings", async () => {
    const result = await extractCandidate();
    expect(exportKind(result, "Mixed")).toBe("union");
    const uncertain = result.warnings.filter((warning) => warning.code === "uncertain-component-recognition");
    expect(uncertain).toHaveLength(1);
    expect(uncertain[0]?.name).toBe("Mixed");
    const mixedOmitted = omittedCallableMembers(result, "Mixed");
    expect(mixedOmitted).toHaveLength(2);
    expect(mixedOmitted.map((warning) => warning.structuralPath.join("/"))).toEqual([
      "Mixed/callSignatures/0/parameters/props",
      "Mixed/callSignatures/0/parameters/props",
    ]);
  });

  it("publishes seven warnings in retained order without the rejected Factory candidate", async () => {
    const result = await extractCandidate();
    expect(result.warnings).toHaveLength(7);
    expect(result.warnings.map(publishedWarningKey)).toEqual(retainedWarningKeys);
  });

  it("yields identical warning lists when extracting the same file twice in one scope", async () => {
    await withCandidateProject(async ({ tsconfigPath, inputPath }) => {
      const [first, second] = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const extractor = yield* ProjectExtractor;
            const firstResult = yield* extractor.extractModule(inputPath);
            const secondResult = yield* extractor.extractModule(inputPath);
            return [firstResult, secondResult] as const;
          }).pipe(Effect.provide(ProjectExtractor.live({ tsconfigPath })))
        )
      );
      expect(first.warnings).toEqual(second.warnings);
      expect(exportKind(first, "Card")).toBe("component");
      expect(exportKind(first, "Mixed")).toBe("union");
      expect(exportKind(first, "Factory")).toBe("function");
      expect(exportKind(first, "factory")).toBe("function");
    });
  });
});
