import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { packageManifestGitPath, resolveReleasePackage } from "../src/config.ts";

function withCheckout(run: (root: string) => void): void {
  const parent = mkdtempSync(join(tmpdir(), "elmera-release-config-"));
  const root = join(parent, "checkout");
  mkdirSync(root);
  try {
    run(root);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function writePackage(directory: string, name: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), `${JSON.stringify({ name, version: "0.0.0" })}\n`);
}

describe("release package config", () => {
  it("accepts a package that is not Internal", () => {
    withCheckout((root) => {
      const directory = join(root, "packages/app");
      writePackage(directory, "@acme/app");
      expect(resolveReleasePackage(root, directory, "@acme/app")).toEqual({
        checkoutRoot: resolve(root),
        packageDirectory: resolve(directory),
        packageName: "@acme/app",
      });
      expect(packageManifestGitPath(resolveReleasePackage(root, directory, "@acme/app"))).toBe(
        "packages/app/package.json"
      );
    });
  });

  it("accepts the checkout root as the package directory", () => {
    withCheckout((root) => {
      writePackage(root, "@acme/root-app");
      const resolved = resolveReleasePackage(root, root, "@acme/root-app");
      expect(resolved.packageDirectory).toBe(resolve(root));
      expect(packageManifestGitPath(resolved)).toBe("package.json");
    });
  });

  it("rejects a package directory that escapes the checkout", () => {
    withCheckout((root) => {
      const outside = join(root, "..", "outside-app");
      writePackage(outside, "@acme/app");
      expect(() => resolveReleasePackage(root, outside, "@acme/app")).toThrow("outside the checkout root");
      expect(() => resolveReleasePackage(root, join(root, "packages", "..", ".."), "@acme/app")).toThrow(
        "outside the checkout root"
      );
    });
  });

  it("rejects a missing package.json and a name mismatch", () => {
    withCheckout((root) => {
      const directory = join(root, "packages/app");
      mkdirSync(directory, { recursive: true });
      expect(() => resolveReleasePackage(root, directory, "@acme/app")).toThrow("package.json");
      writePackage(directory, "@acme/app");
      expect(() => resolveReleasePackage(root, directory, "@elmeragroup/internal")).toThrow(
        "Package name @elmeragroup/internal does not match @acme/app"
      );
    });
  });
});
