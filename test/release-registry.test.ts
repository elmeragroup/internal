import { describe, expect, it } from "vitest";

import { readRegistry } from "../scripts/release-registry.ts";

const commit = "a".repeat(40);

describe("registry failures", () => {
  it("represents missing dist integrity as absence", async () => {
    const registry = await readRegistry(() =>
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
    expect((await readRegistry(() => Promise.resolve(new Response("", { status: 404 })))).versions.size).toBe(
      0
    );
  });
  it.each([401, 403, 429, 500])("fails closed for HTTP %s", async (status) => {
    await expect(readRegistry(() => Promise.resolve(new Response("", { status })))).rejects.toThrow(
      "lookup failed"
    );
  });
  it("does not turn network failures or malformed data into an empty registry", async () => {
    await expect(readRegistry(() => Promise.reject(new Error("offline")))).rejects.toThrow("offline");
    await expect(readRegistry(() => Promise.resolve(Response.json({ error: "invalid" })))).rejects.toThrow();
  });
});
