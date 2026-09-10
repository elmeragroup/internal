import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createGitPort } from "../src/git.ts";
import { commitBaseline, withGitWorkspace, workspaceTimeout } from "./lib/git-workspace.ts";
import type { GitWorkspace, WorkspaceHead } from "./lib/git-workspace.ts";

const manifestPath = "packages/internal/package.json";
const packageManifest = "packages/internal/package.json";
const remoteTrackingRef = "origin/main";
const packageName = "@elmeragroup/internal";
const unknownCommit = "0".repeat(40);

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
        const head = createGitPort(workspace.path, packageManifest, remoteTrackingRef).head();
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
          const port = createGitPort(workspace.path, packageManifest, remoteTrackingRef);
          expect(port.originMain()).toBe(baseline);
          expect(port.head()).toBe(advanced);
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
        expect(createGitPort(workspace.path, packageManifest, remoteTrackingRef).isClean()).toBe(true);
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
        expect(createGitPort(workspace.path, packageManifest, remoteTrackingRef).isClean()).toBe(true);
      });
    },
    workspaceTimeout
  );

  it(
    "reports a modified tracked file as dirty",
    () => {
      withCheckout("0.4.0", (workspace) => {
        writeManifest(workspace, "0.4.1");
        expect(createGitPort(workspace.path, packageManifest, remoteTrackingRef).isClean()).toBe(false);
      });
    },
    workspaceTimeout
  );

  it(
    "reports a staged deletion of a tracked file as dirty",
    () => {
      withCheckout("0.4.0", (workspace) => {
        workspace.git(["rm", "--quiet", manifestPath]);
        expect(createGitPort(workspace.path, packageManifest, remoteTrackingRef).isClean()).toBe(false);
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
          createGitPort(workspace.path, "packages/app/package.json", remoteTrackingRef).stableVersionAt(
            baseline
          )
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
        const port = createGitPort(workspace.path, packageManifest, remoteTrackingRef);
        expect(port.stableVersionAt(advanced)).toBe("0.4.1");
        expect(port.stableVersionAt(`${advanced}^1`)).toBe("0.4.0");
        expect(port.stableVersionAt(baseline)).toBe("0.4.0");
      });
    },
    workspaceTimeout
  );

  it(
    "rejects a canary version recorded in the manifest",
    () => {
      withCheckout("0.4.1-canary.3", (workspace, baseline) => {
        expect(() =>
          createGitPort(workspace.path, packageManifest, remoteTrackingRef).stableVersionAt(baseline)
        ).toThrow("Expected a stable version; received 0.4.1-canary.3");
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
        expect(() =>
          createGitPort(workspace.path, packageManifest, remoteTrackingRef).stableVersionAt(baseline)
        ).toThrow(/does not exist/);
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
        expect(() =>
          createGitPort(workspace.path, packageManifest, remoteTrackingRef).stableVersionAt(baseline)
        ).toThrow("recorded manifest version is not a string");
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
        expect(() =>
          createGitPort(workspace.path, packageManifest, remoteTrackingRef).stableVersionAt(baseline)
        ).toThrow("recorded manifest is not a JSON object");
      });
    },
    workspaceTimeout
  );
});

describe("git port commit ancestry", () => {
  it(
    "answers in the direction the supersession check depends on",
    () => {
      withCheckout("0.4.0", (workspace, baseline) => {
        writeManifest(workspace, "0.4.1");
        const advanced = commitAll(workspace, "release 0.4.1");
        const port = createGitPort(workspace.path, packageManifest, remoteTrackingRef);
        expect(port.isAncestor(baseline, advanced)).toBe(true);
        expect(port.isAncestor(advanced, baseline)).toBe(false);
        expect(port.isAncestor(baseline, baseline)).toBe(true);
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
        const port = createGitPort(workspace.path, packageManifest, remoteTrackingRef);
        expect(port.isAncestor(left, right)).toBe(false);
        expect(port.isAncestor(right, left)).toBe(false);
        expect(port.isAncestor(baseline, left)).toBe(true);
        expect(port.isAncestor(baseline, right)).toBe(true);
      });
    },
    workspaceTimeout
  );

  it(
    "refuses to guess when a commit is unknown to the checkout",
    () => {
      withCheckout("0.4.0", (workspace, baseline) => {
        const port = createGitPort(workspace.path, packageManifest, remoteTrackingRef);
        expect(() => port.isAncestor(unknownCommit, baseline)).toThrow(
          "Cannot establish release commit ancestry"
        );
        expect(() => port.isAncestor(baseline, unknownCommit)).toThrow(
          "Cannot establish release commit ancestry"
        );
      });
    },
    workspaceTimeout
  );

  it.each(["HEAD", "origin/main", "0".repeat(39), "0".repeat(41), "A".repeat(40), "0123456f"])(
    "rejects %s as a commit before running git",
    (invalid) => {
      withCheckout("0.4.0", (workspace, baseline) => {
        const port = createGitPort(
          join(workspace.path, "absent-checkout"),
          packageManifest,
          remoteTrackingRef
        );
        expect(() => port.isAncestor(invalid, baseline)).toThrow(
          `Expected a full commit SHA; received ${invalid}`
        );
        expect(() => port.isAncestor(baseline, invalid)).toThrow(
          `Expected a full commit SHA; received ${invalid}`
        );
      });
    },
    workspaceTimeout
  );

  it(
    "rethrows a spawn failure instead of reporting an answer",
    () => {
      withCheckout("0.4.0", (workspace, baseline) => {
        const port = createGitPort(
          join(workspace.path, "absent-checkout"),
          packageManifest,
          remoteTrackingRef
        );
        expect(() => port.isAncestor(baseline, baseline)).toThrow(/ENOENT/);
      });
    },
    workspaceTimeout
  );
});
