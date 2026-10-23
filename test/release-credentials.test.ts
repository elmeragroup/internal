import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withoutReleaseCredentials } from "../scripts/lib/release-credentials.ts";
import { runCommand } from "../scripts/lib/run-command.ts";

// The child writes the variables it can see, so the test observes exactly what a spawned build sees.
const REPORT_CHILD_ENV =
  "require('node:fs').writeFileSync(process.argv[1], Object.entries(process.env).map(([name, value]) => `${name}=${value}`).join('\\n'))";

const publishStepEnv = {
  PATH: "/usr/bin:/bin",
  GH_TOKEN: "test-gh",
  GITHUB_TOKEN: "test-github",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-oidc",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example.test",
};

const credentialNames = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
];

const directories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("release credential strip", () => {
  it("hides the GitHub tokens and the OIDC request pair from a child command", () => {
    // The test process holds the credentials too, so a child that inherited this process's
    // environment instead of the stripped copy would report them.
    for (const name of credentialNames) vi.stubEnv(name, "test-inherited");
    const directory = mkdtempSync(join(tmpdir(), "release-credentials-"));
    directories.push(directory);
    const report = join(directory, "env.txt");
    runCommand(
      process.execPath,
      ["-e", REPORT_CHILD_ENV, report],
      directory,
      withoutReleaseCredentials(publishStepEnv)
    );
    const seen = readFileSync(report, "utf8").split("\n");
    expect(seen).toContain("PATH=/usr/bin:/bin");
    expect(seen.filter((line) => credentialNames.some((name) => line.startsWith(`${name}=`)))).toEqual([]);
  });

  it("leaves the caller's environment unchanged", () => {
    const env = { ...publishStepEnv };
    withoutReleaseCredentials(env);
    expect(env).toEqual(publishStepEnv);
  });
});
