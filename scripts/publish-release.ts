import { parseReleaseCommand, runRelease } from "./release-pipeline.ts";

await runRelease(
  parseReleaseCommand(process.argv.slice(2)),
  process.env.GITHUB_REPOSITORY ?? "",
  process.env.GH_TOKEN ?? ""
);
