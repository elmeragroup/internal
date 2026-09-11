import { describe, expect, it } from "vitest";

import { parseReleaseCommand } from "../scripts/lib/release-command.ts";

const commit = "a".repeat(40);

describe("release CLI command", () => {
  it("dispatches main versus retry at the boundary", () => {
    expect(parseReleaseCommand(["main", commit])).toEqual({ mode: "main", commit });
    expect(parseReleaseCommand(["retry", "v0.2.0"])).toEqual({ mode: "retry", tag: "v0.2.0" });
    expect(parseReleaseCommand(["retry", `canary-${commit}`])).toEqual({
      mode: "retry",
      tag: `canary-${commit}`,
    });
  });

  it.each<[readonly string[]]>([[[]], [["main"]], [["publish", commit]]])("rejects %j", (argv) => {
    expect(() => parseReleaseCommand(argv)).toThrow();
  });
});
