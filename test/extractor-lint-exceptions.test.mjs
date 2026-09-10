import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { asRecordArray, isString, readJsonObject } from "../scripts/lib/json-object.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const extractorRoot = join(repoRoot, "packages", "api-extractor");

/** File-wide headers: `/* oxlint-disable …` or `// oxlint-disable …` without `-next-line`. */
const fileWideDisable = /(?:\/\*|\/\/)\s*oxlint-disable(?!-next-line)\b/;
const nextLineDisable = /oxlint-disable-next-line\s+(\S+)([^\n]*)/g;

/**
 * @param {string} directory
 * @returns {string[]}
 */
function sourceFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "fixtures" || entry.name === "dist") continue;
      found.push(...sourceFiles(full));
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) found.push(full);
  }
  return found;
}

/**
 * @param {Record<string, unknown>} override
 * @returns {string[]}
 */
function overrideFiles(override) {
  const files = override.files;
  if (!Array.isArray(files)) throw new Error("override.files is not an array");
  return files.filter((file) => isString(file));
}

describe("api-extractor lint exceptions", () => {
  const files = sourceFiles(extractorRoot);

  it("has sources to check", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("carries no file-wide oxlint-disable header", () => {
    const offenders = files
      .filter((file) => fileWideDisable.test(readFileSync(file, "utf8")))
      .map((file) => relative(repoRoot, file));
    expect(offenders).toEqual([]);
  });

  it("gives every next-line disable a reason", () => {
    const offenders = [];
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(nextLineDisable)) {
        if (!match[2].includes("--") || match[2].replace(/^.*--/, "").trim() === "") {
          offenders.push(`${relative(repoRoot, file)}: ${match[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("takes no path-wide exemption in .oxlintrc.json", () => {
    const parsed = readJsonObject(join(repoRoot, ".oxlintrc.json"));
    const exempted = asRecordArray(parsed.overrides, "overrides")
      .flatMap((entry) => overrideFiles(entry))
      .filter((file) => file.startsWith("packages/api-extractor"));
    expect(exempted).toEqual([]);
  });

  it("keeps next-line disables at or under the per-rule ceiling", () => {
    /** Empty-object-spread sprawl is gone; this is the current max so the count cannot regrow. */
    const ceiling = 17;
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(nextLineDisable)) {
        counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
      }
    }
    const offenders = [...counts.entries()]
      .filter(([, count]) => count > ceiling)
      .map(([rule, count]) => `${rule}: ${count}`)
      .sort();
    expect(offenders).toEqual([]);
    expect(counts.get("anti-slop/no-conditional-empty-object-spread") ?? 0).toBe(0);
  });
});
