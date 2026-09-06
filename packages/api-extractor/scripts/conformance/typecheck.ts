import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { runIfMain } from "../cli.ts";
import { packageVersion } from "../fixture-evidence.ts";
import { conformanceTypecheckPlan } from "../fixture-plans.ts";
import { conformanceFixtureManifest } from "../fixture-plans.ts";
import type { ConformanceFixture } from "../fixture-plans.ts";

const packageDirectory = resolve(import.meta.dirname, "../..");
const fixtureDirectory = join(packageDirectory, "test/fixtures");
const compilerScript = resolve(packageDirectory, "node_modules/typescript/bin/tsc");
const typecheckCommandPrefix = "node scripts/conformance/typecheck.ts" as const;
const typecheckCompilerOptions = [
  "--ignoreConfig",
  "--noEmit",
  "--module",
  "ESNext",
  "--moduleResolution",
  "Bundler",
  "--jsx",
  "react-jsx",
  "--target",
  "ES2022",
  "--strict",
  "--skipLibCheck",
  "false",
  "--pretty",
  "false",
] as const;

export type TypecheckResult = {
  readonly status: "pass" | "failed";
  readonly strategy: "direct-input" | "virtual-upstream-dependency";
  readonly command: string;
  readonly diagnosticCount: number;
  readonly diagnostics: readonly string[];
};

export function issue14TypecheckStrategy(
  definition: ConformanceFixture
): "direct-input" | "virtual-upstream-dependency" {
  const entry = conformanceTypecheckPlan.find((candidate) => candidate.fixture === definition.fixture);
  if (entry === undefined) throw new Error(`Missing type-check plan for ${definition.fixture}.`);
  return entry.strategy;
}

/** The exact package-relative command that the persisted evidence records. */
export function issue14TypecheckCommand(definition: ConformanceFixture): string {
  return `${typecheckCommandPrefix} --fixture ${definition.fixture} --pretty false`;
}

function diagnosticsFrom(output: string): readonly string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replaceAll(packageDirectory, "<package>"));
}

function runTsc(definition: ConformanceFixture, inputPath: string, cwd: string): TypecheckResult {
  const result = spawnSync(process.execPath, [compilerScript, ...typecheckCompilerOptions, inputPath], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [result.stdout, result.stderr].join("\n");
  const diagnostics = diagnosticsFrom(output);
  return {
    status: result.status === 0 && result.error === undefined ? "pass" : "failed",
    strategy: issue14TypecheckStrategy(definition),
    command: issue14TypecheckCommand(definition),
    diagnosticCount: diagnostics.length,
    diagnostics,
  };
}

function typecheckWithVirtualDependency(definition: ConformanceFixture, inputPath: string): TypecheckResult {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "api-extractor-issue14-typecheck-"));
  const stagedInput = join(temporaryRoot, "test/fixtures/module-imports-only/input.ts");
  const stagedDependency = join(temporaryRoot, "src/models/export.ts");
  try {
    mkdirSync(dirname(stagedInput), { recursive: true });
    mkdirSync(dirname(stagedDependency), { recursive: true });
    // The staged tree is test-only; the copied input itself remains immutable.
    const input = readFileSync(inputPath);
    writeFileSync(stagedInput, input);
    writeFileSync(stagedDependency, "export class ExportNode {}\n");
    symlinkSync(join(packageDirectory, "node_modules"), join(temporaryRoot, "node_modules"), "junction");
    return runTsc(definition, stagedInput, temporaryRoot);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function typecheckFixture(definition: ConformanceFixture): TypecheckResult {
  const inputPath = join(fixtureDirectory, definition.fixture, definition.file);
  return issue14TypecheckStrategy(definition) === "virtual-upstream-dependency"
    ? typecheckWithVirtualDependency(definition, inputPath)
    : runTsc(definition, inputPath, packageDirectory);
}

function cliFixture(): ConformanceFixture {
  const fixtureName = process.argv[process.argv.indexOf("--fixture") + 1];
  const definition = conformanceFixtureManifest.find((candidate) => candidate.fixture === fixtureName);
  if (definition === undefined) throw new Error(`Unknown Issue 14 fixture: ${fixtureName ?? "<missing>"}`);
  if (
    process.argv[process.argv.indexOf("--pretty") + 1] !== "false" ||
    packageVersion("typescript") !== "7.0.2"
  ) {
    throw new Error("Issue 14 typecheck command requires --pretty false and typescript@7.0.2.");
  }
  return definition;
}

function main(): void {
  const result = typecheckFixture(cliFixture());
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "pass") process.exitCode = 1;
}

await runIfMain(import.meta.url, main);
