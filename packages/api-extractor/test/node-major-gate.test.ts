import { Schema } from "effect";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { issue14TimingCommand } from "../scripts/conformance/contract.ts";
import { assertNodeMajor, issue02TimingCommand, requiredNodeMajor } from "../scripts/files.ts";
import { assertTimingReportInvariants, Issue14TimingReportSchema } from "../scripts/timing/issue14.ts";

const issue14ReportPath = resolve(import.meta.dirname, "fixtures/timing-conformance.json");

describe("Node-major timing gate", () => {
  it("accepts any Node 24 patch and rejects other majors", () => {
    expect(requiredNodeMajor).toBe(24);
    expect(() => assertNodeMajor("24.13.0")).not.toThrow();
    expect(() => assertNodeMajor("24.14.0")).not.toThrow();
    expect(() => assertNodeMajor("23.11.0")).toThrow(/Node 24\.x/u);
    expect(() => assertNodeMajor("25.0.0")).toThrow(/Node 24\.x/u);
  });

  it("keeps timing command identity free of fnm and the Node patch", () => {
    expect(issue02TimingCommand).toBe("node scripts/timing.ts --plan issue02 --check");
    expect(issue14TimingCommand).toBe("node scripts/timing.ts --plan issue14 --check");
    expect(issue02TimingCommand).not.toMatch(/fnm|24\.13/u);
    expect(issue14TimingCommand).not.toMatch(/fnm|24\.13/u);
  });

  it("keeps Issue 14 timing invariants passing under a non-24.13 Node 24", () => {
    const report = Schema.decodeUnknownSync(Issue14TimingReportSchema)(
      JSON.parse(readFileSync(issue14ReportPath, "utf8"))
    );
    expect(report.command).toBe(issue14TimingCommand);
    const simulated = structuredClone(report);
    Reflect.set(simulated.runtime, "node", "24.14.0");
    expect(() => assertTimingReportInvariants(simulated)).not.toThrow();
    expect(simulated.runtime.node).toBe("24.14.0");

    const wrongMajor = structuredClone(report);
    Reflect.set(wrongMajor.runtime, "node", "25.0.0");
    expect(() => assertTimingReportInvariants(wrongMajor)).toThrow(/Node 24\.x/u);
  });
});
