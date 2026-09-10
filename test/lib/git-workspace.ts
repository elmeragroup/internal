import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Each case builds a git repository and runs git — and sometimes the Changesets CLI — in
 * subprocesses; the default five-second case timeout is not enough for that and made the suite
 * flake roughly one run in three.
 */
export const workspaceTimeout = 30_000;

/** `branch` is an ordinary clone; `detached` is the single-commit checkout the publisher runs in. */
export type WorkspaceHead = "branch" | "detached";

export type GitWorkspace = {
  path: string;
  git: (args: readonly string[]) => string;
};

/**
 * Runs one case against an empty git repository in a temporary directory, removed afterwards.
 * The committer identity, hooks path, and signing setting are fixed so a developer's own git
 * configuration cannot change what the case observes.
 */
export function withGitWorkspace(prefix: string, run: (workspace: GitWorkspace) => void): void {
  const path = mkdtempSync(join(tmpdir(), prefix));
  const hooksDir = join(path, ".empty-git-hooks");
  try {
    mkdirSync(hooksDir);
    const git = (args: readonly string[]): string =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=ReleaseTest",
          "-c",
          "user.email=release-test@example.invalid",
          "-c",
          `core.hooksPath=${hooksDir}`,
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd: path, env: { ...process.env, HUSKY: "0" }, encoding: "utf8", stdio: "pipe" }
      ).trim();
    git(["init", "--initial-branch=main"]);
    run({ path, git });
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

/**
 * Commits everything currently written into the workspace and points `origin/main` at it, because
 * `actions/checkout` fetches remote-tracking refs and both head shapes rely on that ref resolving.
 * A `detached` head then checks out the bare commit and drops the local branch, which is the state
 * the Publish Release workflow runs every ordinary canary in — there, a bare `main` does not
 * resolve.
 */
export function commitBaseline(workspace: GitWorkspace, head: WorkspaceHead = "branch"): string {
  workspace.git(["add", "."]);
  workspace.git(["commit", "-m", "baseline"]);
  workspace.git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  if (head === "detached") {
    workspace.git(["checkout", "--detach", "HEAD"]);
    workspace.git(["branch", "-D", "main"]);
  }
  return workspace.git(["rev-parse", "HEAD"]);
}
