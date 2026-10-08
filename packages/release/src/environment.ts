import { Redacted } from "effect";

import { resendOnDroppedConnection } from "./connection-retry.ts";
import type { GitHubConnection } from "./github.ts";
import { runNpmCli } from "./npm.ts";
import type { NpmRunner } from "./npm.ts";

/**
 * The transport every live operation runs over: the GitHub connection, whose `fetch` also reads
 * the npm registry, the npm CLI runner, and the progress log. Tests inject a fake remote here;
 * nothing else in the engine is replaceable.
 */
export type ReleaseEnvironment = GitHubConnection & {
  npm: NpmRunner;
  log: (message: string) => void;
};

/** Reads credentials no earlier than the operation that needs them. */
export function releaseEnvironment(): ReleaseEnvironment {
  return {
    repository: process.env.GITHUB_REPOSITORY ?? "",
    token: Redacted.make(process.env.GH_TOKEN ?? ""),
    fetch: resendOnDroppedConnection((input, init) => globalThis.fetch(input, init)),
    npm: runNpmCli,
    log: (message) => {
      console.log(message);
    },
  };
}
