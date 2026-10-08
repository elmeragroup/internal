import { Effect, Redacted } from "effect";
import type { Scope } from "effect";

import type { GitHubConnection } from "./github.ts";
import { runNpmCli } from "./npm.ts";
import type { NpmRunner } from "./npm.ts";
import { acquireReleaseTransport } from "./release-transport.ts";

/**
 * The transport every live operation runs over: the GitHub connection, whose `fetch` also reads
 * the npm registry, the npm CLI runner, and the progress log. Tests inject a fake remote here;
 * nothing else in the engine is replaceable.
 */
export type ReleaseEnvironment = GitHubConnection & {
  npm: NpmRunner;
  log: (message: string) => void;
};

/**
 * Reads credentials no earlier than the operation that needs them, and acquires the operation's
 * own transport, which is released with the scope.
 */
export function releaseEnvironment(): Effect.Effect<ReleaseEnvironment, never, Scope.Scope> {
  return Effect.map(acquireReleaseTransport(), (fetch) => ({
    repository: process.env.GITHUB_REPOSITORY ?? "",
    token: Redacted.make(process.env.GH_TOKEN ?? ""),
    fetch,
    npm: runNpmCli,
    log: (message) => {
      console.log(message);
    },
  }));
}
