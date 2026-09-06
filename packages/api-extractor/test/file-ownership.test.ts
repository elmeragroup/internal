import { describe, expect, it } from "vitest";

import { classifySourceFile, isExternalSourceFile } from "../src/backend/ts7/file-ownership.ts";

describe("backend source-file ownership classification", () => {
  it.each([
    [
      "Unix ordinary dependency",
      "/repo/node_modules/pkg/index.d.ts",
      { kind: "dependency", packageName: "pkg" },
    ],
    [
      "Windows ordinary dependency",
      String.raw`C:\repo\node_modules\pkg\index.d.ts`,
      { kind: "dependency", packageName: "pkg" },
    ],
    [
      "Unix TypeScript standard library",
      "/repo/node_modules/typescript/lib/lib.dom.d.ts",
      { kind: "typescript", library: "standard-library" },
    ],
    [
      "Windows TypeScript standard library",
      String.raw`C:\repo\node_modules\typescript\lib\lib.dom.d.ts`,
      { kind: "typescript", library: "standard-library" },
    ],
    [
      "Unix @typescript toolchain library",
      "/repo/node_modules/@typescript/tsc/lib/lib.es2022.d.ts",
      { kind: "typescript", library: "standard-library" },
    ],
    [
      "Windows @typescript toolchain library",
      String.raw`C:\repo\node_modules\@typescript\tsc\lib\lib.es2022.d.ts`,
      { kind: "typescript", library: "standard-library" },
    ],
    [
      "Unix TypeScript non-standard declaration",
      "/repo/node_modules/typescript/lib/index.d.ts",
      { kind: "typescript", library: "toolchain" },
    ],
    [
      "Windows TypeScript non-standard declaration",
      String.raw`C:\repo\node_modules\typescript\lib\index.d.ts`,
      { kind: "typescript", library: "toolchain" },
    ],
    ["Unix project source", "/repo/src/index.ts", { kind: "project" }],
    ["Windows project source", String.raw`C:\repo\src\index.ts`, { kind: "project" }],
    [
      "non-TypeScript dependency library",
      "/repo/node_modules/pkg/lib/index.d.ts",
      { kind: "dependency", packageName: "pkg" },
    ],
    [
      "Unix @typescript-eslint parser library",
      "/repo/node_modules/@typescript-eslint/parser/lib/index.d.ts",
      { kind: "dependency", packageName: "@typescript-eslint/parser" },
    ],
    [
      "Windows @typescript-eslint parser library",
      String.raw`C:\repo\node_modules\@typescript-eslint\parser\lib\index.d.ts`,
      { kind: "dependency", packageName: "@typescript-eslint/parser" },
    ],
    [
      "Unix typescript-eslint library",
      "/repo/node_modules/typescript-eslint/lib/index.d.ts",
      { kind: "dependency", packageName: "typescript-eslint" },
    ],
    [
      "Windows typescript-eslint library",
      String.raw`C:\repo\node_modules\typescript-eslint\lib\index.d.ts`,
      { kind: "dependency", packageName: "typescript-eslint" },
    ],
    ["Unix project TypeScript-like library", "/repo/src/my-typescript/lib/index.d.ts", { kind: "project" }],
    [
      "Windows project TypeScript-like library",
      String.raw`C:\repo\src\my-typescript\lib\index.d.ts`,
      { kind: "project" },
    ],
  ] as const)("classifies $0", (_label, filePath, expected) => {
    expect(classifySourceFile(filePath)).toEqual(expected);
  });

  it.each([
    [
      "Unix project TypeScript-shaped library with compiler metadata",
      "/repo/src/typescript/lib/lib.dom.d.ts",
      { kind: "project" },
      { externalLibrary: false, defaultLibrary: false },
    ],
    [
      "Windows project @typescript-shaped library with compiler metadata",
      String.raw`C:\repo\src\@typescript\tsc\lib\lib.es2022.d.ts`,
      { kind: "project" },
      { externalLibrary: false, defaultLibrary: false },
    ],
    [
      "non-node_modules compiler default library",
      "/opt/typescript/lib/lib.es2022.d.ts",
      { kind: "typescript", library: "standard-library" },
      { externalLibrary: false, defaultLibrary: true },
    ],
    [
      "non-node_modules external compiler declaration",
      "/opt/typescript/lib/index.d.ts",
      { kind: "typescript", library: "toolchain" },
      { externalLibrary: true, defaultLibrary: false },
    ],
    [
      "external declaration with no identifiable package owner",
      "/vendor/declarations/index.d.ts",
      { kind: "external" },
      { externalLibrary: true, defaultLibrary: false },
    ],
  ] as const)("combines compiler metadata for $0", (_label, filePath, expected, metadata) => {
    expect(classifySourceFile(filePath, metadata)).toEqual(expected);
  });

  it.each([
    [
      "explicit project metadata overrides a TypeScript-shaped path",
      "/repo/src/typescript/lib/lib.dom.d.ts",
      { isFromExternalLibrary: false, isDefaultLibrary: false },
      false,
    ],
    [
      "absent metadata keeps the TypeScript-shaped path fallback",
      "/repo/src/typescript/lib/lib.dom.d.ts",
      undefined,
      true,
    ],
    [
      "explicit external metadata remains external",
      "/repo/src/typescript/lib/lib.dom.d.ts",
      { isFromExternalLibrary: true, isDefaultLibrary: false },
      true,
    ],
  ] as const)("uses $0", (_label, filePath, metadata, expected) => {
    expect(isExternalSourceFile(filePath, metadata)).toBe(expected);
  });
});
