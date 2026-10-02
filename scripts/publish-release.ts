import { Effect } from "effect";

import { releaseCheckedCommit, retryRelease } from "@elmeragroup/release";

import { internalPackAndVerify } from "./internal-pack-adapter.ts";
import { parseReleaseCommand } from "./lib/release-command.ts";
import { releaseLayout } from "./release.ts";

const command = parseReleaseCommand(process.argv.slice(2));
if (command.mode === "main") {
  await Effect.runPromise(releaseCheckedCommit(releaseLayout(), internalPackAndVerify, command.commit));
} else {
  await Effect.runPromise(retryRelease(releaseLayout(), command.tag));
}
