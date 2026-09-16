import { Effect } from "effect";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { ReleasePackage } from "../src/files.ts";
import { createNpmPublisher, readRegistry } from "../src/npm.ts";

const commit = "a".repeat(40);
const packageName = "@elmeragroup/internal";

describe("registry failures", () => {
  it("looks up the requested package name", async () => {
    const requested: string[] = [];
    await Effect.runPromise(
      readRegistry("@acme/app", (url) => {
        requested.push(url instanceof URL ? url.href : url instanceof Request ? url.url : url);
        return Promise.resolve(new Response("", { status: 404 }));
      })
    );
    expect(requested).toEqual(["https://registry.npmjs.org/@acme%2fapp"]);
  });
  it("represents missing dist integrity as absence", async () => {
    const registry = await Effect.runPromise(
      readRegistry(packageName, () =>
        Promise.resolve(
          Response.json({
            versions: { "0.1.0": { dist: {}, elmeraRelease: { commit } } },
            "dist-tags": {},
          })
        )
      )
    );
    expect(registry.versions.get("0.1.0")).toEqual({ integrity: undefined, commit });
  });
  it("keeps an unusable recorded commit as absent metadata instead of blocking every read", async () => {
    const registry = await Effect.runPromise(
      readRegistry(packageName, () =>
        Promise.resolve(
          Response.json({
            versions: { "0.1.0": { dist: {}, elmeraRelease: { commit: "main" } } },
            "dist-tags": {},
          })
        )
      )
    );
    expect(registry.versions.get("0.1.0")?.commit).toBeUndefined();
  });
  it("keeps an unusable legacy gitHead as absent metadata", async () => {
    const registry = await Effect.runPromise(
      readRegistry(packageName, () =>
        Promise.resolve(
          Response.json({ versions: { "0.1.0": { dist: {}, gitHead: "main" } }, "dist-tags": {} })
        )
      )
    );
    expect(registry.versions.get("0.1.0")?.commit).toBeUndefined();
  });
  it("treats only a real 404 as a new package", async () => {
    const registry = await Effect.runPromise(
      readRegistry(packageName, () => Promise.resolve(new Response("", { status: 404 })))
    );
    expect(registry.versions.size).toBe(0);
  });
  it.each([401, 403, 429, 500])("fails closed for HTTP %s", async (status) => {
    await expect(
      Effect.runPromise(readRegistry(packageName, () => Promise.resolve(new Response("", { status }))))
    ).rejects.toThrow("lookup failed");
  });
  it("does not turn network failures or malformed data into an empty registry", async () => {
    await expect(
      Effect.runPromise(readRegistry(packageName, () => Promise.reject(new Error("offline"))))
    ).rejects.toThrow("offline");
    await expect(
      Effect.runPromise(readRegistry(packageName, () => Promise.resolve(Response.json({ error: "invalid" }))))
    ).rejects.toThrow();
  });
  it("names the malformed version in the decode cause", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        readRegistry(packageName, () =>
          Promise.resolve(
            Response.json({
              versions: { "0.1.0": { dist: "not-an-object" } },
              "dist-tags": {},
            })
          )
        )
      )
    );
    expect(failure._tag).toBe("ReleaseError");
    expect(failure.message).toBe("npm registry is invalid");
    const decodeError = failure.cause;
    if (!(decodeError instanceof Error)) throw new Error("expected a wrapped decode error");
    const schemaError = decodeError.cause;
    if (!(schemaError instanceof Error)) throw new Error("expected a wrapped schema error");
    expect(schemaError.message).toContain('["versions"]["0.1.0"]["dist"]');
  });
});

describe("npm CLI failures", () => {
  it("includes the captured stderr in the failure message", async () => {
    const pkg: ReleasePackage = {
      checkoutRoot: process.cwd(),
      packageDirectory: process.cwd(),
      packageName: "@acme/app",
    };
    // npm fails locally on a missing tarball, so this reaches the real CLI without a registry write.
    const failure = await Effect.runPromise(
      Effect.flip(createNpmPublisher(pkg).publish("/elmera-release-test/missing.tgz"))
    );
    expect(failure).toMatchObject({ _tag: "ReleaseError" });
    expect(failure.message).toMatch(/^npm failed with status \d+: /u);
    expect(failure.message).toContain("npm error code ENOENT");
  });
});

describe("npm CLI output", () => {
  it("re-emits captured stderr after a successful npm run", async () => {
    const bin = mkdtempSync(join(tmpdir(), "elmera-npm-bin-"));
    const script = join(bin, "npm");
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((...args: unknown[]) => {
      written.push(String(args[0]));
      return true;
    });
    try {
      // A fake npm on PATH reaches the real spawn without a registry write. The absolute shebang
      // keeps the shim runnable while PATH points only at the fake bin directory.
      writeFileSync(script, `#!${process.execPath}\nprocess.stderr.write("npm notice published");\n`);
      chmodSync(script, 0o755);
      vi.stubEnv("PATH", bin);
      const pkg: ReleasePackage = {
        checkoutRoot: process.cwd(),
        packageDirectory: process.cwd(),
        packageName: "@acme/app",
      };
      await Effect.runPromise(createNpmPublisher(pkg).publish("release.tgz"));
    } finally {
      stderr.mockRestore();
      vi.unstubAllEnvs();
      rmSync(bin, { recursive: true, force: true });
    }
    expect(written.join("")).toContain("npm notice published");
  });
});
