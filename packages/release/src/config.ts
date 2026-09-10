import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { asString, parseJsonObject } from "./json.ts";

export type ReleasePackage = {
  checkoutRoot: string;
  packageDirectory: string;
  packageName: string;
};

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function assertDirectory(path: string, label: string): void {
  if (!isDirectory(path)) throw new Error(`${label} is not a directory`);
}

function isInsideCheckout(checkoutRoot: string, packageDirectory: string): boolean {
  const inside = relative(checkoutRoot, packageDirectory);
  return inside === "" || (!inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside));
}

export function resolveReleasePackage(
  checkoutRoot: string,
  packageDirectory: string,
  packageName: string
): ReleasePackage {
  const root = resolve(checkoutRoot);
  const directory = resolve(packageDirectory);
  assertDirectory(root, "Checkout root");
  if (!isInsideCheckout(root, directory)) {
    throw new Error("Package directory is outside the checkout root");
  }
  const manifestPath = resolve(directory, "package.json");
  if (!existsSync(manifestPath)) throw new Error("Package directory does not contain package.json");
  const name = asString(parseJsonObject(readFileSync(manifestPath, "utf8"), "package manifest").name, "name");
  if (name !== packageName) {
    throw new Error(`Package name ${packageName} does not match ${name}`);
  }
  return { checkoutRoot: root, packageDirectory: directory, packageName };
}
