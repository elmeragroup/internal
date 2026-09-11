import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { readRegistry } from "../src/npm.ts";

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
