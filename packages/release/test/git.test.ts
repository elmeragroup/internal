import { Effect } from "effect";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createCommitAncestry, createGitPort } from "../src/git.ts";
import type { GitPort } from "../src/git.ts";
import { commitBaseline, withGitWorkspace, workspaceTimeout } from "./lib/git-workspace.ts";
import type { GitWorkspace, WorkspaceHead } from "./lib/git-workspace.ts";

const manifestPath = "packages/internal/package.json";
const remoteTrackingRef = "origin/main";
const packageName = "@elmeragroup/internal";
const unknownCommit = "0".repeat(40);

/** A live git port over `root`. */
function gitPort(root: string, manifest = manifestPath): GitPort {
  return createGitPort(root, manifest, remoteTrackingRef);
}

function writeManifest(workspace: GitWorkspace, version: string): void {
  mkdirSync(join(workspace.path, "packages/internal"), { recursive: true });
  writeFileSync(
    join(workspace.path, manifestPath),
    `${JSON.stringify({ name: packageName, private: false, version }, null, 2)}\n`
  );
}

function writeManifestText(workspace: GitWorkspace, text: string): void {
  mkdirSync(join(workspace.path, "packages/internal"), { recursive: true });
  writeFileSync(join(workspace.path, manifestPath), text);
}

function commitAll(workspace: GitWorkspace, message: string): string {
  workspace.git(["add", "--all"]);
  workspace.git(["commit", "-m", message]);
  return workspace.git(["rev-parse", "HEAD"]);
}

/** A checkout holding one released manifest, in either of the two head shapes the publisher sees. */
function withCheckout(
  version: string,
  run: (workspace: GitWorkspace, baseline: string) => void,
  head: WorkspaceHead = "branch"
): void {
  withGitWorkspace("elmera-release-git-", (workspace) => {
    writeManifest(workspace, version);
    run(workspace, commitBaseline(workspace, head));
  });
}

describe("git port head resolution", () => {
  it(
    "reads the checked-out commit as a full SHA",
    () => {
      withCheckout("0.4.0", (workspace, baseline) => {
        const head = Effect.runSync(gitPort(workspace.path).head());
        expect(head).toBe(baseline);
        expect(head).toMatch(/^[0-9a-f]{40}$/);
      });
    },
    workspaceTimeout
  );

  it(
    "resolves origin/main from the remote-tracking ref alone",
    () => {
      withCheckout(
        "0.4.0",
        (workspace, baseline) => {
          expect(() => workspace.git(["rev-parse", "--verify", "main"])).toThrow();
          writeManifest(workspace, "0.4.1");
          const advanced = commitAll(workspace, "advance past origin/main");
          const port = gitPort(workspace.path);
          expect(Effect.runSync(port.originMain())).toBe(baseline);
          expect(Effect.runSync(port.head())).toBe(advanced);
        },
        "detached"
      );
    },
    workspaceTimeout
  );
});

describe("git port working tree cleanliness", () => {
  it(
    "reports a freshly committed tree as clean",
    () => {
      withCheckout("0.4.0", (workspace) => {
        expect(Effect.runSync(gitPort(workspace.path).isClean())).toBe(true);
      });
    },
    workspaceTimeout
  );

  it(
    "leaves an untracked file out of the cleanliness decision",
    () => {
      withCheckout("0.4.0", (workspace) => {
        writeFileSync(join(workspace.path, "scratch.txt"), "build output\n");
        expect(workspace.git(["status", "--porcelain"])).not.toBe("");
        expect(Effect.runSync(gitPort(workspace.path).isClean())).toBe(true);
      });
    },
    workspaceTimeout
  );

  it(
    "reports a modified tracked file as dirty",
    () => {
      withCheckout("0.4.0", (workspace) => {
        writeManifest(workspace, "0.4.1");
        expect(Effect.runSync(gitPort(workspace.path).isClean())).toBe(false);
      });
    },
    workspaceTimeout
  );

  it(
    "reports a staged deletion of a tracked file as dirty",
    () => {
      withCheckout("0.4.0", (workspace) => {
        workspace.git(["rm", "--quiet", manifestPath]);
        expect(Effect.runSync(gitPort(workspace.path).isClean())).toBe(false);
      });
    },
    workspaceTimeout
  );
});

describe("git port manifest version at a revision", () => {
  it(
    "reads a package manifest that is not packages/internal",
    () => {
      withGitWorkspace("elmera-release-git-", (workspace) => {
        mkdirSync(join(workspace.path, "packages/app"), { recursive: true });
        writeFileSync(
          join(workspace.path, "packages/app/package.json"),
          `${JSON.stringify({ name: "@acme/app", private: false, version: "1.4.2" }, null, 2)}\n`
        );
        const baseline = commitBaseline(workspace);
        expect(
          Effect.runSync(gitPort(workspace.path, "packages/app/package.json").stableVersionAt(baseline))
        ).toBe("1.4.2");
      });
    },
    workspaceTimeout
  );

  it(
    "reads the recorded version at a revision and at the parent form the pipeline passes",
    () => {
      withCheckout("0.4.0", (workspace, baseline) => {
        writeManifest(workspace, "0.4.1");
        const advanced = commitAll(workspace, "release 0.4.1");
        const port = gitPort(workspace.path);
        expect(Effect.runSync(port.stableVersionAt(advanced))).toBe("0.4.1");
        expect(Effect.runSync(port.stableVersionAt(`${advanced}^1`))).toBe("0.4.0");
        expect(Effect.runSync(port.stableVersionAt(baseline))).toBe("0.4.0");
      });
    },
    workspaceTimeout
  );

  it(
    "rejects a canary version recorded in the manifest",
    () => {
      withCheckout("0.4.1-canary.3", (workspace, baseline) => {
        expect(() => Effect.runSync(gitPort(workspace.path).stableVersionAt(baseline))).toThrow(
          "Expected a stable version; received 0.4.1-canary.3"
        );
      });
    },
    workspaceTimeout
  );

  it(
    "fails when the manifest is absent at that revision",
    () => {
      withGitWorkspace("elmera-release-git-", (workspace) => {
        writeFileSync(join(workspace.path, "README.md"), "no package here\n");
        const baseline = commitBaseline(workspace);
        expect(() => Effect.runSync(gitPort(workspace.path).stableVersionAt(baseline))).toThrow(
          /does not exist/
        );
      });
    },
    workspaceTimeout
  );

  it(
    "fails when the recorded manifest carries no version",
    () => {
      withGitWorkspace("elmera-release-git-", (workspace) => {
        writeManifestText(workspace, `${JSON.stringify({ name: packageName })}\n`);
        const baseline = commitBaseline(workspace);
        expect(() => Effect.runSync(gitPort(workspace.path).stableVersionAt(baseline))).toThrow(
          "recorded manifest is invalid"
        );
      });
    },
    workspaceTimeout
  );

  it(
    "fails when the recorded manifest is not a JSON object",
    () => {
      withGitWorkspace("elmera-release-git-", (workspace) => {
        writeManifestText(workspace, "[]\n");
        const baseline = commitBaseline(workspace);
        expect(() => Effect.runSync(gitPort(workspace.path).stableVersionAt(baseline))).toThrow(
          "recorded manifest is invalid"
        );
      });
    },
    workspaceTimeout
  );
});

describe("commit ancestry", () => {
  it(
    "answers in the direction the supersession check depends on",
    () => {
      withCheckout("0.4.0", (workspace, baseline) => {
        writeManifest(workspace, "0.4.1");
        const advanced = commitAll(workspace, "release 0.4.1");
        const ancestry = createCommitAncestry(workspace.path);
        expect(ancestry(baseline, advanced)).toBe(true);
        expect(ancestry(advanced, baseline)).toBe(false);
        expect(ancestry(baseline, baseline)).toBe(true);
      });
    },
    workspaceTimeout
  );

  it(
    "reports diverged commits as unrelated in both directions",
    () => {
      withCheckout("0.4.0", (workspace, baseline) => {
        writeFileSync(join(workspace.path, "left.txt"), "left\n");
        const left = commitAll(workspace, "left");
        workspace.git(["checkout", "--quiet", baseline]);
        writeFileSync(join(workspace.path, "right.txt"), "right\n");
        const right = commitAll(workspace, "right");
        const ancestry = createCommitAncestry(workspace.path);
        expect(ancestry(left, right)).toBe(false);
        expect(ancestry(right, left)).toBe(false);
        expect(ancestry(baseline, left)).toBe(true);
        expect(ancestry(baseline, right)).toBe(true);
      });
    },
    workspaceTimeout
  );

  it(
    "refuses to guess when a commit is unknown to the checkout",
    () => {
      withCheckout("0.4.0", (workspace, baseline) => {
        const ancestry = createCommitAncestry(workspace.path);
        expect(() => ancestry(unknownCommit, baseline)).toThrow("Cannot establish release commit ancestry");
        expect(() => ancestry(baseline, unknownCommit)).toThrow("Cannot establish release commit ancestry");
      });
    },
    workspaceTimeout
  );

  it.each(["HEAD", "origin/main", "0".repeat(39), "0".repeat(41), "A".repeat(40), "0123456f"])(
    "rejects %s as a commit before running git",
    (invalid) => {
      withCheckout("0.4.0", (workspace, baseline) => {
        const ancestry = createCommitAncestry(join(workspace.path, "absent-checkout"));
        expect(() => ancestry(invalid, baseline)).toThrow(`Expected a full commit SHA; received ${invalid}`);
        expect(() => ancestry(baseline, invalid)).toThrow(`Expected a full commit SHA; received ${invalid}`);
      });
    },
    workspaceTimeout
  );

  it(
    "rethrows a spawn failure instead of reporting an answer",
    () => {
      withCheckout("0.4.0", (workspace, baseline) => {
        const ancestry = createCommitAncestry(join(workspace.path, "absent-checkout"));
        expect(() => ancestry(baseline, baseline)).toThrow(/ENOENT/);
      });
    },
    workspaceTimeout
  );
});
