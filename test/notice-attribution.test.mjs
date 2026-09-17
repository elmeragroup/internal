import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const notice = readFileSync(join(repoRoot, "packages", "internal", "NOTICE"), "utf8");

describe("NOTICE attribution", () => {
  it("retains the upstream copyright holders", () => {
    expect(notice).toContain("Michał Dudak");
    expect(notice).toContain("Dillon Mulroy");
  });

  it("retains the pinned upstream commits", () => {
    expect(notice).toContain("at commit e145350");
    expect(notice).toContain("Commit: 446268e5d15baa968eaec669ff65358d36ae6259");
  });
});
