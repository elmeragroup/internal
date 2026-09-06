/**
 * Timing evidence entry point.
 *
 *   node scripts/timing.ts --plan issue02 [--check|--write]
 *   node scripts/timing.ts --plan issue14 [--check|--check-portability|--write]
 *   node scripts/timing.ts --plan externalSelection [--check]
 *
 * Every plan measures through the public extraction seam in a fresh project;
 * the report shapes stay with their plan modules under scripts/timing/.
 */

import { runIfMain } from "./cli.ts";
import { assertNodeMajor } from "./files.ts";
import type { TimingPlan } from "./fixture-catalog.ts";
import { runExternalSelectionTiming } from "./timing/external-selection.ts";
import { runIssue02Timing } from "./timing/issue02.ts";
import { runIssue14Timing } from "./timing/issue14.ts";

type TimingMode = "--check" | "--check-portability" | "--write";
type TimingInvocation = { readonly plan: TimingPlan; readonly mode: TimingMode };

const timingPlans: readonly TimingPlan[] = ["issue02", "issue14", "externalSelection"];
const timingModes: readonly TimingMode[] = ["--check", "--check-portability", "--write"];

function isTimingPlan(value: string | undefined): value is TimingPlan {
  return timingPlans.some((plan) => plan === value);
}

function isTimingMode(value: string): value is TimingMode {
  return timingModes.some((mode) => mode === value);
}

function parseArguments(arguments_: readonly string[]): TimingInvocation {
  if (arguments_.some((argument) => argument.endsWith("output.json"))) {
    throw new Error("Timing regeneration refuses to target the immutable output.json oracle.");
  }
  const planIndex = arguments_.indexOf("--plan");
  const plan = planIndex === -1 ? undefined : arguments_[planIndex + 1];
  if (!isTimingPlan(plan)) throw new Error(`Use --plan ${timingPlans.join("|")}.`);
  const modes = arguments_.filter((argument, index) => index !== planIndex && index !== planIndex + 1);
  if (modes.length === 0) return { plan, mode: "--check" };
  const [mode] = modes;
  if (modes.length !== 1 || mode === undefined || !isTimingMode(mode)) {
    throw new Error("Use exactly one of --check, --check-portability, or --write.");
  }
  return { plan, mode };
}

async function main(): Promise<void> {
  assertNodeMajor();
  const { plan, mode } = parseArguments(process.argv.slice(2));
  switch (plan) {
    case "issue02":
      if (mode === "--check-portability") throw new Error("The issue02 plan has no portability mode.");
      await runIssue02Timing(mode === "--write" ? "write" : "check");
      return;
    case "issue14":
      await runIssue14Timing(
        mode === "--write"
          ? "write"
          : mode === "--check-portability"
            ? "verify-checkout-portability"
            : "enforce-live-budget"
      );
      return;
    case "externalSelection":
      if (mode !== "--check") throw new Error("The externalSelection plan only supports --check.");
      await runExternalSelectionTiming();
      return;
  }
}

await runIfMain(import.meta.url, main);
