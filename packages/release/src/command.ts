import { assertCommit, assertReleaseTag } from "./intent.ts";

export type ReleaseCommand = { mode: "main"; commit: string } | { mode: "retry"; tag: string };

export function parseReleaseCommand(argv: readonly string[]): ReleaseCommand {
  const [mode, target] = argv;
  if (mode === undefined || target === undefined) {
    throw new Error("Usage: pnpm release:run main <commit> | retry <record-tag>");
  }
  if (mode === "main") return { mode: "main", commit: assertCommit(target) };
  if (mode === "retry") return { mode: "retry", tag: assertReleaseTag(target) };
  throw new Error("Usage: pnpm release:run main <commit> | retry <record-tag>");
}
