import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { asRecordArray, asString, isString, readJsonObject } from "./lib/json-object.mjs";
import { assertStableReleaseVersion, nextPatchVersion } from "./release-version.ts";
import { packageName, repoRoot } from "./release.ts";

const changesetBin = createRequire(import.meta.url).resolve("@changesets/cli/bin.js");
// Relative to the directory the CLI runs in, and inside the ignored scratch directory.
const planFileName = ".artifacts/changeset-release-plan.json";

/** One entry of the Changesets release plan; `type` is `none` for a package that stays put. */
export type PlannedRelease = {
  name: string;
  type: string;
  newVersion: string;
};

/**
 * Asks Changesets which releases the pending changesets in `cwd` would produce.
 *
 * Two properties of the pinned CLI are load-bearing here. It writes `--output` with
 * `path.join(cwd, output)`, so the path must stay relative to the directory the CLI runs in; an
 * absolute path is concatenated onto that directory instead. It also resolves the configured
 * `baseBranch` through `git merge-base`, which is why `.changeset/config.json` names
 * `origin/main` — the publisher runs in a detached checkout of one commit, where a bare `main`
 * does not resolve. Passing `--since` is not a substitute: it also filters out every changeset
 * added before that ref, which would silently plan the wrong version.
 */
export function readReleasePlan(cwd: string): PlannedRelease[] {
  const planPath = resolve(cwd, planFileName);
  mkdirSync(resolve(cwd, ".artifacts"), { recursive: true });
  try {
    execFileSync(process.execPath, [changesetBin, "status", "--output", planFileName], {
      cwd,
      stdio: "pipe",
    });
    return asRecordArray(readJsonObject(planPath).releases, "release plan").map((release) => ({
      name: asString(release.name, "planned package"),
      type: asString(release.type, "planned bump"),
      newVersion: asString(release.newVersion, "planned version"),
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "changeset status failed";
    const details = error instanceof Error && "stderr" in error && isString(error.stderr) ? error.stderr : "";
    throw new Error(details === "" ? message : `${message}\n${details}`, { cause: error });
  } finally {
    rmSync(planPath, { force: true });
  }
}

/** The stable version a fresh canary counts up from: the planned release, else the next patch. */
export function plannedCanaryBase(current: string, cwd = repoRoot): string {
  const planned = readReleasePlan(cwd).filter(
    (release) => release.name === packageName && release.type !== "none"
  );
  if (planned.length > 1) throw new Error("Multiple release plans for the public package");
  const release = planned[0];
  if (release === undefined) return nextPatchVersion(current);
  return assertStableReleaseVersion(release.newVersion);
}
