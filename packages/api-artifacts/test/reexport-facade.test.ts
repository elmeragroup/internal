import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { generateApiArtifacts } from "../src/index.ts";

const require = createRequire(import.meta.url);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A declaration-only dependency, like `react-aria`: the facade forwards its values. */
const dependencyFiles = {
  "node_modules/dep-aria/package.json": JSON.stringify({
    name: "dep-aria",
    version: "1.0.0",
    type: "module",
    main: "./index.js",
    types: "./index.d.ts",
  }),
  "node_modules/dep-aria/index.js": "export function Focusable() {}\nexport function useFocusable() {}\n",
  "node_modules/dep-aria/index.d.ts": `import type { ReactNode } from "react";
export interface FocusableOptions {
  /** Whether the element is disabled. */
  isDisabled?: boolean;
}
export interface FocusableProps extends FocusableOptions {
  children: ReactNode;
}
export declare function Focusable(props: FocusableProps): ReactNode;
export declare function useFocusable(props: FocusableOptions): { focusableProps: object };
`,
};

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "api-artifacts-facade-"));
  roots.push(root);
  await writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        types: [],
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "react-jsx",
        lib: ["ES2022", "DOM"],
        skipLibCheck: true,
      },
      include: ["src/**/*.ts", "src/**/*.tsx"],
    })
  );
  for (const [relative, source] of Object.entries({ ...dependencyFiles, ...files })) {
    const filePath = path.join(root, relative);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, source);
  }
  const reactRoot = path.dirname(require.resolve("react/package.json"));
  const typesRoot = path.dirname(require.resolve("@types/react/package.json"));
  await mkdir(path.join(root, "node_modules/@types"), { recursive: true });
  await symlink(reactRoot, path.join(root, "node_modules/react"));
  await symlink(typesRoot, path.join(root, "node_modules/@types/react"));
  return root;
}

const focusableFacade = {
  "src/focusable.ts": `export { Focusable, useFocusable } from "./focusable/focusable";
export type { FocusableOptions } from "./focusable/focusable";
`,
  "src/focusable/focusable.tsx": `"use client";
/** Focusable wrapper from dep-aria. */
export { Focusable, useFocusable } from "dep-aria";
export type { FocusableOptions } from "dep-aria";
`,
};

const focusableComponent = {
  slug: "focusable",
  entryFile: "src/focusable.ts",
  exportNames: ["Focusable", "useFocusable"],
  outputFile: "docs/focusable/api.json",
};

describe("re-export-only facades (issue #4)", () => {
  it("publishes zero-prop parts for dependency values forwarded through an authored client module", async () => {
    const root = await fixture(focusableFacade);
    const result = await generateApiArtifacts({
      projectRoot: root,
      tsconfigPath: "tsconfig.json",
      components: [focusableComponent],
    });
    expect(result.components[0]?.parts).toEqual([
      {
        name: "Focusable",
        rsc: "client",
        sourcePath: "src/focusable/focusable.tsx",
        props: [],
        forwardedFrom: ["dep-aria"],
        forwardedCount: 2,
      },
      {
        name: "useFocusable",
        rsc: "client",
        sourcePath: "src/focusable/focusable.tsx",
        props: [],
        forwardedFrom: ["dep-aria"],
        forwardedCount: 1,
      },
    ]);
    const written: unknown = JSON.parse(await readFile(path.join(root, "docs/focusable/api.json"), "utf8"));
    expect(written).toMatchObject({
      slug: "focusable",
      parts: [{ name: "Focusable" }, { name: "useFocusable" }],
    });
  });

  it("passes check mode once the forwarded artifact is written, and reports drift before", async () => {
    const root = await fixture(focusableFacade);
    const options = { projectRoot: root, tsconfigPath: "tsconfig.json", components: [focusableComponent] };
    await expect(generateApiArtifacts({ ...options, mode: "check" })).rejects.toMatchObject({
      name: "ApiArtifactsDriftError",
      files: [path.join(root, "docs/focusable/api.json")],
    });
    await generateApiArtifacts(options);
    const checked = await generateApiArtifacts({ ...options, mode: "check" });
    expect(checked.components[0]?.changed).toBe(false);
  });

  it("reads the directive from the entry itself when it forwards the dependency directly", async () => {
    const root = await fixture({
      "src/entry.ts": `export { Focusable } from "dep-aria";\n`,
    });
    const result = await generateApiArtifacts({
      projectRoot: root,
      tsconfigPath: "tsconfig.json",
      components: [
        {
          slug: "direct",
          entryFile: "src/entry.ts",
          exportNames: ["Focusable"],
          outputFile: "docs/direct/api.json",
        },
      ],
    });
    expect(result.components[0]?.parts[0]).toMatchObject({
      name: "Focusable",
      rsc: "server",
      sourcePath: "src/entry.ts",
      props: [],
      forwardedFrom: ["dep-aria"],
    });
  });

  it("publishes an authored value alias of a dependency declaration from the aliasing module", async () => {
    const root = await fixture({
      "src/entry.ts": `export { Focusable } from "./focusable/focusable";\n`,
      "src/focusable/focusable.tsx": `"use client";
import { Focusable as DepFocusable } from "dep-aria";
export const Focusable = DepFocusable;
`,
    });
    const result = await generateApiArtifacts({
      projectRoot: root,
      tsconfigPath: "tsconfig.json",
      components: [
        {
          slug: "alias",
          entryFile: "src/entry.ts",
          exportNames: ["Focusable"],
          outputFile: "docs/alias/api.json",
        },
      ],
    });
    expect(result.components[0]?.parts[0]).toMatchObject({
      name: "Focusable",
      rsc: "client",
      sourcePath: "src/focusable/focusable.tsx",
      props: [],
      forwardedFrom: ["dep-aria"],
      forwardedCount: 2,
    });
  });

  it("still rejects a declaration-only value the project itself declares", async () => {
    const root = await fixture({
      "src/declared.d.ts": `export declare function DeclaredOnly(props: { label: string }): null;\n`,
      "src/entry.ts": `export { DeclaredOnly } from "./declared";\n`,
    });
    await expect(
      generateApiArtifacts({
        projectRoot: root,
        tsconfigPath: "tsconfig.json",
        components: [
          {
            slug: "declared",
            entryFile: "src/entry.ts",
            exportNames: ["DeclaredOnly"],
            outputFile: "docs/declared/api.json",
          },
        ],
      })
    ).rejects.toThrow(/DeclaredOnly: could not recover the authored implementation \(no-implementation\)/u);
  });
});
