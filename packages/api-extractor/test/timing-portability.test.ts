import { Schema } from "effect";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  LiveBudgetTimingCommandOutputSchema,
  PortabilityTimingCommandOutputSchema,
} from "../scripts/timing/issue14.ts";

const packageDirectory = resolve(import.meta.dirname, "..");
const repositoryDirectory = resolve(packageDirectory, "../..");
const packageRelativeScript = "scripts/timing.ts";
const repositoryRelativeScript = "packages/api-extractor/scripts/timing.ts";
const childCommandTimeoutMs = 15_000;
const relocatedCheckoutTestTimeoutMs = childCommandTimeoutMs * 3 + 15_000;

type PortabilityTimingCommandOutput = Schema.Schema.Type<typeof PortabilityTimingCommandOutputSchema>;
const TimingCommandJsonSchema = Schema.Record(Schema.String, Schema.Json);
type TimingCommandJson = Schema.Schema.Type<typeof TimingCommandJsonSchema>;

function runTimingCommand(
  cwd: string,
  script: string,
  mode: "--check" | "--check-portability"
): TimingCommandJson {
  const result = spawnSync(process.execPath, [script, "--plan", "issue14", mode], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: childCommandTimeoutMs,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return Schema.decodeUnknownSync(TimingCommandJsonSchema)(JSON.parse(result.stdout));
}

function runPortabilityTimingCommand(cwd: string, script: string): PortabilityTimingCommandOutput {
  const output = runTimingCommand(cwd, script, "--check-portability");
  expect(output).not.toHaveProperty("decision");
  return Schema.decodeUnknownSync(PortabilityTimingCommandOutputSchema)(output);
}

describe("timing command portability", () => {
  it("keeps the portability check distinct from the live budget check", () => {
    const result = spawnSync(
      process.execPath,
      [packageRelativeScript, "--plan", "issue14", "--check", "--check-portability"],
      {
        cwd: packageDirectory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: childCommandTimeoutMs,
      }
    );

    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Use exactly one of --check, --check-portability, or --write.");

    const liveBudgetOutput = runTimingCommand(packageDirectory, packageRelativeScript, "--check");
    expect(liveBudgetOutput).not.toHaveProperty("mode");
    expect(liveBudgetOutput).not.toHaveProperty("semanticDecision");
    expect(() =>
      Schema.decodeUnknownSync(LiveBudgetTimingCommandOutputSchema)(liveBudgetOutput)
    ).not.toThrow();
  });

  it(
    "reaches the same semantic decision from the package, repository, and a relocated checkout",
    { timeout: relocatedCheckoutTestTimeoutMs },
    () => {
      const packageRun = runPortabilityTimingCommand(packageDirectory, packageRelativeScript);
      const repositoryRun = runPortabilityTimingCommand(repositoryDirectory, repositoryRelativeScript);
      const relocatedRepository = mkdtempSync(
        join(tmpdir(), "api-extractor-relocated-checkout-with-a-different-path-length-")
      );
      const relocatedPackage = join(relocatedRepository, "packages/api-extractor");

      try {
        cpSync(packageDirectory, relocatedPackage, {
          recursive: true,
          filter: (source) => source !== join(packageDirectory, "node_modules"),
        });
        symlinkSync(
          join(packageDirectory, "node_modules"),
          join(relocatedPackage, "node_modules"),
          "junction"
        );
        const relocatedRun = runPortabilityTimingCommand(relocatedRepository, repositoryRelativeScript);

        expect([
          packageRun.semanticDecision,
          repositoryRun.semanticDecision,
          relocatedRun.semanticDecision,
        ]).toEqual(["go", "go", "go"]);
        for (const run of [packageRun, repositoryRun, relocatedRun]) {
          expect(Number.isFinite(run.aggregate.measured.bytesSent)).toBe(true);
          expect(Number.isFinite(run.aggregate.measured.bytesReceived)).toBe(true);
          expect(run.aggregate.measured.bytesSent).toBeGreaterThanOrEqual(0);
          expect(run.aggregate.measured.bytesReceived).toBeGreaterThanOrEqual(0);
        }
      } finally {
        rmSync(relocatedRepository, { recursive: true, force: true });
      }
    }
  );
});
