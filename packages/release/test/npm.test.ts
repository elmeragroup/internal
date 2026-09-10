import { describe, expect, it } from "vitest";

import { asString } from "../src/json.ts";
import { readRegistry } from "../src/npm.ts";

const commit = "a".repeat(40);
const packageName = "@elmeragroup/internal";

describe("registry failures", () => {
  it("looks up the requested package name", async () => {
    const requested: string[] = [];
    await readRegistry("@acme/app", (url) => {
      requested.push(asString(url, "request URL"));
      return Promise.resolve(new Response("", { status: 404 }));
    });
    expect(requested).toEqual(["https://registry.npmjs.org/@acme%2fapp"]);
  });
  it("represents missing dist integrity as absence", async () => {
    const registry = await readRegistry(packageName, () =>
      Promise.resolve(
        Response.json({
          versions: { "0.1.0": { dist: {}, elmeraRelease: { commit } } },
          "dist-tags": {},
        })
      )
    );
    expect(registry.versions.get("0.1.0")).toEqual({ integrity: undefined, commit });
  });
  it("treats only a real 404 as a new package", async () => {
    expect(
      (await readRegistry(packageName, () => Promise.resolve(new Response("", { status: 404 })))).versions
        .size
    ).toBe(0);
  });
  it.each([401, 403, 429, 500])("fails closed for HTTP %s", async (status) => {
    await expect(
      readRegistry(packageName, () => Promise.resolve(new Response("", { status })))
    ).rejects.toThrow("lookup failed");
  });
  it("does not turn network failures or malformed data into an empty registry", async () => {
    await expect(readRegistry(packageName, () => Promise.reject(new Error("offline")))).rejects.toThrow(
      "offline"
    );
    await expect(
      readRegistry(packageName, () => Promise.resolve(Response.json({ error: "invalid" })))
    ).rejects.toThrow();
  });
});
