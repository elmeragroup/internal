import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { decodeJson } from "../src/json.ts";
import { createFakeRemote } from "./lib/fake-remote.ts";

const ListedReleases = Schema.Array(Schema.Struct({ tag_name: Schema.String }));

describe("fake GitHub release listing", () => {
  it("clamps an oversized per_page to GitHub's documented maximum of 100", async () => {
    const remote = createFakeRemote("acme/app", "@acme/app");
    for (let index = 0; index < 101; index += 1) {
      remote.seedRelease({ tag: `notes-${String(index)}` });
    }
    const page = async (number: number): Promise<number> => {
      const response = await remote.environment.fetch(
        `https://api.github.com/repos/acme/app/releases?per_page=1000&page=${String(number)}`
      );
      return decodeJson(await response.text(), ListedReleases, "listed releases").length;
    };
    expect(await page(1)).toBe(100);
    expect(await page(2)).toBe(1);
  });
});
