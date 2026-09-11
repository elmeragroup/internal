import { Schema } from "effect";
import type { Effect } from "effect";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { lift } from "./errors.ts";
import type { ReleaseError } from "./errors.ts";
import { readJson } from "./json.ts";
import { assertStableReleaseVersion, nextPatchVersion } from "./version.ts";

// Relative to the directory the CLI runs in, and inside the ignored scratch directory.
const planFileName = ".artifacts/changeset-release-plan.json";

const ChangesetConfig = Schema.Struct({
  baseBranch: Schema.String,
});

const PlannedReleaseEntry = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  newVersion: Schema.String,
});

const ChangesetPlan = Schema.Struct({
  releases: Schema.Array(PlannedReleaseEntry),
});

/** One entry of the Changesets release plan; `type` is `none` for a package that stays put. */
export type PlannedRelease = typeof PlannedReleaseEntry.Type;

function changesetBin(checkoutRoot: string): string {
  return createRequire(resolve(checkoutRoot, "package.json")).resolve("@changesets/cli/bin.js");
}

export function changesetBaseBranch(checkoutRoot: string): string {
  const base = readJson(resolve(checkoutRoot, ".changeset/config.json"), ChangesetConfig).baseBranch;
  if (!base.startsWith("origin/")) {
    throw new Error("Changesets baseBranch must be a remote-tracking ref (origin/<branch>)");
  }
  return base;
}

/** The branch Changesets tracks, without the `origin/` prefix. */
export function trackedBranchOf(baseBranch: string): string {
  return baseBranch.slice("origin/".length);
}

/**
 * Asks Changesets which releases the pending changesets in `checkoutRoot` would produce.
 *
 * Two properties of the pinned CLI are load-bearing here. It writes `--output` with
 * `path.join(cwd, output)`, so the path must stay relative to the directory the CLI runs in; an
 * absolute path is concatenated onto that directory instead. It also resolves the configured
 * `baseBranch` through `git merge-base`, which is why `.changeset/config.json` names
 * `origin/<branch>` — the publisher runs in a detached checkout of one commit, where a bare branch
 * name does not resolve. Passing `--since` is not a substitute: it also filters out every changeset
 * added before that ref, which would silently plan the wrong version.
 *
 * The CLI binary is resolved from the consuming checkout, never from this package's location.
 */
export function readReleasePlan(checkoutRoot: string): readonly PlannedRelease[] {
  const planPath = resolve(checkoutRoot, planFileName);
  mkdirSync(resolve(checkoutRoot, ".artifacts"), { recursive: true });
  try {
    execFileSync(process.execPath, [changesetBin(checkoutRoot), "status", "--output", planFileName], {
      cwd: checkoutRoot,
      stdio: "pipe",
    });
    return readJson(planPath, ChangesetPlan).releases;
  } catch (error) {
    const message = error instanceof Error ? error.message : "changeset status failed";
    const stderr = error instanceof Error && "stderr" in error ? error.stderr : undefined;
    const details = Schema.is(Schema.String)(stderr) ? stderr : "";
    throw new Error(details === "" ? message : `${message}\n${details}`, { cause: error });
  } finally {
    rmSync(planPath, { force: true });
  }
}

/** The stable version a fresh canary counts up from: the planned release, else the next patch. */
export function plannedCanaryBase(
  current: string,
  packageName: string,
  checkoutRoot: string
): Effect.Effect<string, ReleaseError> {
  return lift(() => {
    const planned = readReleasePlan(checkoutRoot).filter(
      (release) => release.name === packageName && release.type !== "none"
    );
    if (planned.length > 1) throw new Error("Multiple release plans for the public package");
    const release = planned[0];
    if (release === undefined) return nextPatchVersion(current);
    return assertStableReleaseVersion(release.newVersion);
  });
}
