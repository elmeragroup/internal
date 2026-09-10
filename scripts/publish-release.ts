import { Effect } from "effect";

import { parseReleaseCommand, releaseCheckedCommit, retryRelease } from "../packages/release/src/index.ts";
import { createInternalPackAndVerify } from "./internal-pack-adapter.ts";
import { releasePackage } from "./release.ts";

const command = parseReleaseCommand(process.argv.slice(2));
if (command.mode === "main") {
  await Effect.runPromise(
    releaseCheckedCommit(releasePackage, createInternalPackAndVerify(), command.commit)
  );
} else {
  await Effect.runPromise(retryRelease(releasePackage, command.tag));
}
