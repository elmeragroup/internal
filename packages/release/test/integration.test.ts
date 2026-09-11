import { Effect, Schema } from "effect";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { verifyReleaseArchive } from "../src/archive.ts";
import type { EngineDeps, PackAndVerify } from "../src/engine.ts";
import { executeCheckedCommit } from "../src/engine.ts";
import { createStableReleaseGate } from "../src/gate.ts";
import { createCommitAncestry, createGitPort } from "../src/git.ts";
import { createGitHubClient } from "../src/github.ts";
import type { ReleaseIntent, VerifiedRelease } from "../src/intent.ts";
import { readRegistry } from "../src/npm.ts";
import { plannedCanaryBase } from "../src/plan.ts";
import { createReleaseStore } from "../src/store.ts";

const packageName = "@acme/ui";
const repository = "acme/ui";
const githubApi = `https://api.github.com/repos/${repository}`;
const githubUploads = `https://uploads.github.com/repos/${repository}`;
const npmRegistry = "https://registry.npmjs.org/@acme%2fui";

const TagRequest = Schema.Struct({ ref: Schema.String, sha: Schema.String });
const ReleaseRequest = Schema.Struct({ tag_name: Schema.String, body: Schema.String });

type FixtureJson =
  | string
  | number
  | boolean
  | null
  | readonly FixtureJson[]
  | { readonly [key: string]: FixtureJson };

function jsonResponse(value: FixtureJson, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonBodyText(body: RequestInit["body"]): string {
  if (Object.prototype.toString.call(body) !== "[object String]") {
    throw new Error("expected a JSON string body");
  }
  // SAFETY: the toString tag above proves this body is a string.
  return body as string;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=ReleaseTest",
      "-c",
      "user.email=release-test@example.invalid",
      "-c",
      `core.hooksPath=${join(cwd, ".empty-git-hooks")}`,
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", env: { ...process.env, HUSKY: "0" }, stdio: "pipe" }
  ).trim();
}

function packArchive(intent: ReleaseIntent): Uint8Array {
  const directory = mkdtempSync(join(tmpdir(), "acme-ui-pack-"));
  try {
    mkdirSync(join(directory, "package"));
    writeFileSync(
      join(directory, "package/package.json"),
      JSON.stringify({
        name: packageName,
        version: intent.version,
        elmeraRelease: { commit: intent.commit, channel: intent.channel },
      })
    );
    const archive = join(directory, "package.tgz");
    execFileSync("tar", ["-czf", archive, "-C", directory, "package"]);
    return new Uint8Array(readFileSync(archive));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("recorded canary publication", () => {
  it("publishes the packed archive end to end through a recorded GitHub release", async () => {
    const root = mkdtempSync(join(tmpdir(), "elmera-release-integration-"));
    try {
      const uiDirectory = join(root, "packages/ui");
      mkdirSync(join(root, ".empty-git-hooks"));
      mkdirSync(uiDirectory, { recursive: true });
      mkdirSync(join(root, ".changeset"), { recursive: true });
      writeFileSync(
        join(root, "package.json"),
        `${JSON.stringify({ name: "acme-ui", private: true }, null, 2)}\n`
      );
      writeFileSync(
        join(uiDirectory, "package.json"),
        `${JSON.stringify({ name: packageName, version: "0.1.0" }, null, 2)}\n`
      );
      writeFileSync(
        join(root, ".changeset/config.json"),
        `${JSON.stringify({ baseBranch: "origin/main" })}\n`
      );
      writeFileSync(join(root, ".changeset/README.md"), "ignored\n");
      git(root, ["init", "--initial-branch=main"]);
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "baseline"]);
      writeFileSync(join(uiDirectory, "README.md"), "ui\n");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "head"]);
      git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      const commit = git(root, ["rev-parse", "HEAD"]);

      mkdirSync(join(root, "node_modules/@changesets/cli"), { recursive: true });
      writeFileSync(
        join(root, "node_modules/@changesets/cli/package.json"),
        JSON.stringify({ name: "@changesets/cli", version: "0.0.0" })
      );
      writeFileSync(
        join(root, "node_modules/@changesets/cli/bin.js"),
        `const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
const output = process.argv[process.argv.indexOf("--output") + 1];
const file = resolve(process.cwd(), output);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify({ releases: [] }));
`
      );

      let packedBytes: Uint8Array | undefined;
      let uploadedArchive: Uint8Array | undefined;
      let patchedRelease = false;
      let createdTag: { ref: string; sha: string } | undefined;
      let draft:
        | { tag_name: string; id: number; draft: boolean; body: string; assets: readonly never[] }
        | undefined;
      let verifiedRelease: VerifiedRelease | undefined;
      let publishedVersion: { version: string; integrity: string; commit: string } | undefined;
      let distTag: { tag: string; version: string } | undefined;
      let publishedArchivePath: string | undefined;

      const fixtureFetch: typeof fetch = async (url, init = {}) => {
        const href = url instanceof URL ? url.href : url instanceof Request ? url.url : url;
        const method = init.method ?? "GET";
        if (method === "GET" && href === npmRegistry) {
          if (publishedVersion === undefined) return new Response("", { status: 404 });
          return jsonResponse({
            versions: {
              [publishedVersion.version]: {
                dist: { integrity: publishedVersion.integrity },
                elmeraRelease: { commit: publishedVersion.commit },
              },
            },
            "dist-tags": distTag === undefined ? {} : { [distTag.tag]: distTag.version },
          });
        }
        if (method === "GET" && href === `${githubApi}/releases?per_page=100&page=1`) {
          return jsonResponse([]);
        }
        if (method === "GET" && href.startsWith(`${githubApi}/git/ref/tags/`)) {
          const tag = decodeURIComponent(href.slice(`${githubApi}/git/ref/tags/`.length));
          if (createdTag === undefined || createdTag.ref !== `refs/tags/${tag}`) {
            return new Response("", { status: 404 });
          }
          return jsonResponse({ object: { type: "commit", sha: createdTag.sha } });
        }
        if (method === "POST" && href === `${githubApi}/git/refs`) {
          const requested = Schema.decodeUnknownSync(TagRequest)(JSON.parse(jsonBodyText(init.body)));
          expect(requested.ref).toMatch(/^refs\/tags\/canary-/);
          expect(requested.sha).toMatch(/^[a-f0-9]{40}$/);
          createdTag = { ref: requested.ref, sha: requested.sha };
          return jsonResponse({ object: { type: "commit", sha: requested.sha } });
        }
        if (method === "POST" && href === `${githubApi}/releases`) {
          const requested = Schema.decodeUnknownSync(ReleaseRequest)(JSON.parse(jsonBodyText(init.body)));
          expect(requested.tag_name).toMatch(/^canary-/);
          expect(requested.body).toContain("elmera-release");
          draft = { tag_name: requested.tag_name, id: 1, draft: true, body: requested.body, assets: [] };
          return jsonResponse(draft);
        }
        if (method === "GET" && href === `${githubApi}/releases/1`) {
          if (draft === undefined) throw new Error("expected a created draft");
          return jsonResponse(draft);
        }
        if (method === "POST" && href === `${githubUploads}/releases/1/assets?name=release.tgz`) {
          if (!(init.body instanceof Blob)) throw new Error("expected the archive as a Blob body");
          uploadedArchive = new Uint8Array(await init.body.arrayBuffer());
          return jsonResponse({
            id: 1,
            name: "release.tgz",
            state: "uploaded",
            size: uploadedArchive.length,
          });
        }
        if (method === "GET" && href === `${githubApi}/releases/assets/1`) {
          if (uploadedArchive === undefined) throw new Error("expected an uploaded archive");
          return new Response(uploadedArchive);
        }
        if (method === "PATCH" && href === `${githubApi}/releases/1`) {
          if (draft === undefined) throw new Error("expected a created draft");
          patchedRelease = true;
          return jsonResponse({ ...draft, draft: false });
        }
        throw new Error(`unexpected fetch: ${method} ${href}`);
      };

      const environment = { repository, token: "test-token", fetch: fixtureFetch };
      const client = createGitHubClient(environment);
      const ancestry = createCommitAncestry(root);
      const deps: EngineDeps = {
        git: createGitPort(root, "packages/ui/package.json", "origin/main"),
        ancestry,
        store: createReleaseStore(client, packageName),
        readRegistry: () => readRegistry(packageName, fixtureFetch),
        npm: {
          publish: (archive) =>
            Effect.sync(() => {
              if (verifiedRelease === undefined) throw new Error("expected a verified release");
              publishedArchivePath = archive;
              publishedVersion = {
                version: verifiedRelease.version,
                integrity: verifiedRelease.integrity,
                commit: verifiedRelease.commit,
              };
            }),
          promote: (version, tag) =>
            Effect.sync(() => {
              distTag = { tag, version };
            }),
        },
        confirmationInterval: 0,
        stableGate: createStableReleaseGate(client, root, uiDirectory, "main"),
        plannedCanaryBase: (current) => plannedCanaryBase(current, packageName, root),
        verifyArchive: (intent, bytes) =>
          verifyReleaseArchive(intent, bytes, packageName).pipe(
            Effect.tap((release) =>
              Effect.sync(() => {
                verifiedRelease = release;
              })
            )
          ),
        log: () => undefined,
      };
      const adapter: PackAndVerify = {
        pack: (intent) => {
          packedBytes = packArchive(intent);
          return packedBytes;
        },
      };

      await Effect.runPromise(
        executeCheckedCommit(
          { checkoutRoot: root, packageDirectory: uiDirectory, packageName },
          adapter,
          commit,
          deps
        ).pipe(Effect.scoped)
      );

      expect(packedBytes).toBeDefined();
      expect(publishedArchivePath).toMatch(/release\.tgz$/);
      expect(uploadedArchive).toEqual(packedBytes);
      expect(patchedRelease).toBe(true);
      expect(distTag).toEqual({ tag: "canary", version: "0.1.1-canary.0" });
      expect(draft?.body).toContain("elmera-release");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
