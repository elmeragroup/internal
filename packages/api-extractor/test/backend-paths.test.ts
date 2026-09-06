import { describe, expect, it } from "vitest";

import {
  compilerSourceFileName,
  registeredRootSpelling,
  repositoryRelativePath,
  sameSourceFile,
} from "../src/backend/ts7/path-identity.ts";

describe("TypeScript backend repository paths", () => {
  it("keeps POSIX and VFS path prefixes case-sensitive", () => {
    expect(repositoryRelativePath("/workspace/Repo", "/workspace/Repo/src/input.ts")).toBe("src/input.ts");
    expect(repositoryRelativePath("/workspace/Repo", "/workspace/repo/src/input.ts")).toBe(
      "../repo/src/input.ts"
    );
    expect(repositoryRelativePath("/virtual/Case", "/virtual/case/input.ts")).toBe("../case/input.ts");
    expect(repositoryRelativePath("//virtual/Case", "//virtual/case/input.ts")).toBe("../case/input.ts");
    expect(repositoryRelativePath("/workspace/Repo", "/workspace/Repository/input.ts")).toBe(
      "../Repository/input.ts"
    );
    expect(repositoryRelativePath("/", "/workspace/input.ts")).toBe("workspace/input.ts");
  });

  it("uses Windows path and case rules independent of the host OS", () => {
    expect(repositoryRelativePath("C:\\Workspace\\Repo", "c:\\workspace\\repo\\src\\input.ts")).toBe(
      "src/input.ts"
    );
    expect(repositoryRelativePath("C:\\Workspace\\Repo", "C:\\Workspace\\Other\\input.ts")).toBe(
      "../Other/input.ts"
    );
    expect(
      repositoryRelativePath(
        "\\\\Server\\Share\\Workspace\\Repo",
        "\\\\server\\share\\workspace\\repo\\src\\input.ts"
      )
    ).toBe("src/input.ts");
  });
});

describe("TypeScript backend source-file identity", () => {
  it("folds case-only compiler paths only on Darwin", () => {
    expect(sameSourceFile("/Repo/Foo.ts", "/Repo/Foo.ts", "linux")).toBe(true);
    expect(sameSourceFile("/Repo/Foo.ts", "/Repo\\Foo.ts", "linux")).toBe(true);
    expect(sameSourceFile("/Repo/Foo.ts", "/Repo/foo.ts", "linux")).toBe(false);
    expect(sameSourceFile("/Repo/Foo.ts", "/Repo/foo.ts", "darwin")).toBe(true);
  });
});

describe("compilerSourceFileName", () => {
  const registered = new Set<string>();
  const isRegistered = (candidate: string): boolean => registered.has(candidate);

  it.each([
    {
      name: "returns the input when no candidate is registered",
      path: "/Repo/src/input.ts",
      platform: "linux",
      rootedPath: undefined,
      nativePath: undefined,
      virtualPath: undefined,
      registered: [] as const,
      expected: "/Repo/src/input.ts",
    },
    {
      name: "keeps the Darwin rooted spelling when the prefix case differs",
      path: "/repo/src/input.ts",
      platform: "darwin",
      rootedPath: "/Repo/src/input.ts",
      nativePath: undefined,
      virtualPath: undefined,
      registered: [] as const,
      expected: "/Repo/src/input.ts",
    },
    {
      name: "does not rewrite a Linux path with a case-only root prefix",
      path: "/repo/src/input.ts",
      platform: "linux",
      rootedPath: undefined,
      nativePath: undefined,
      virtualPath: undefined,
      registered: [] as const,
      expected: "/repo/src/input.ts",
    },
    {
      name: "prefers a same-file native spelling",
      path: "/Repo/src/input.ts",
      platform: "linux",
      rootedPath: undefined,
      nativePath: "/Repo/src/input.ts",
      virtualPath: undefined,
      registered: [] as const,
      expected: "/Repo/src/input.ts",
    },
    {
      name: "keeps the compiler spelling when the original path is registered and a virtual path differs",
      path: "/virtual/input.ts",
      platform: "linux",
      rootedPath: undefined,
      nativePath: undefined,
      virtualPath: "/real/input.ts",
      registered: ["/virtual/input.ts"] as const,
      expected: "/virtual/input.ts",
    },
    {
      name: "switches to a registered virtual path when the original is unregistered",
      path: "/virtual/input.ts",
      platform: "linux",
      rootedPath: undefined,
      nativePath: undefined,
      virtualPath: "/real/input.ts",
      registered: ["/real/input.ts"] as const,
      expected: "/real/input.ts",
    },
    {
      name: "keeps a registered original when a different native path exists",
      path: "/Repo/src/input.ts",
      platform: "linux",
      rootedPath: undefined,
      nativePath: "/Repo/src/other.ts",
      virtualPath: undefined,
      registered: ["/Repo/src/input.ts"] as const,
      expected: "/Repo/src/input.ts",
    },
    {
      name: "switches to a registered native path when the original is unregistered",
      path: "/Repo/src/input.ts",
      platform: "linux",
      rootedPath: undefined,
      nativePath: "/Repo/src/real.ts",
      virtualPath: undefined,
      registered: ["/Repo/src/real.ts"] as const,
      expected: "/Repo/src/real.ts",
    },
  ])("$name", (row) => {
    registered.clear();
    for (const path of row.registered) registered.add(path);
    expect(
      compilerSourceFileName(row.path, {
        platform: row.platform,
        rootedPath: row.rootedPath,
        nativePath: row.nativePath,
        virtualPath: row.virtualPath,
        isRegistered,
      })
    ).toBe(row.expected);
  });

  it("restores Darwin root casing only", () => {
    expect(registeredRootSpelling("/repo/src/input.ts", "/Repo", "darwin")).toBe("/Repo/src/input.ts");
    expect(registeredRootSpelling("/repo/src/input.ts", "/Repo", "linux")).toBeUndefined();
    expect(registeredRootSpelling("/Repo/src/input.ts", "/Repo", "darwin")).toBeUndefined();
  });
});
