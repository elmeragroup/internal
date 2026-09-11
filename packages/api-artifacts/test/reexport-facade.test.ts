import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { generateApiArtifacts } from "../src/index.ts";
import { artifactOptions as options, projectFixtures } from "./support/project-fixture.ts";

const fixture = projectFixtures({
  prefix: "api-artifacts-facade-",
  include: ["src/**/*.ts", "src/**/*.tsx"],
  skipLibCheck: true,
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
  "node_modules/dep-aria/index.js":
    "export function Focusable() {}\nexport function useFocusable() {}\nexport const Group = { Focusable };\n",
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
export declare const Group: { Focusable: (props: FocusableProps) => ReactNode };
`,
};

function facade(files: Readonly<Record<string, string>>): Promise<string> {
  return fixture({ ...dependencyFiles, ...files });
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

const focusablePart = {
  name: "Focusable",
  rsc: "client",
  sourcePath: "src/focusable/focusable.tsx",
  props: [],
  forwardedFrom: ["dep-aria"],
  forwardedCount: 2,
};

describe("re-export-only facades (issue #4)", () => {
  it("publishes zero-prop parts for dependency values forwarded through an authored client module", async () => {
    const root = await facade(focusableFacade);
    const result = await generateApiArtifacts(options(root, [focusableComponent]));
    expect(result.components[0]?.parts).toEqual([
      focusablePart,
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

  it("keeps forwarded facades prop-free when the dependency is selected for enrichment", async () => {
    const root = await facade(focusableFacade);
    const result = await generateApiArtifacts({
      ...options(root, [focusableComponent]),
      includeExternalTypes: ["dep-aria"],
    });
    expect(result.components[0]?.parts).toEqual([
      focusablePart,
      {
        name: "useFocusable",
        rsc: "client",
        sourcePath: "src/focusable/focusable.tsx",
        props: [],
        forwardedFrom: ["dep-aria"],
        forwardedCount: 1,
      },
    ]);
  });

  it("passes check mode once the forwarded artifact is written, and reports drift before", async () => {
    const root = await facade(focusableFacade);
    const generate = options(root, [focusableComponent]);
    await expect(generateApiArtifacts({ ...generate, mode: "check" })).rejects.toMatchObject({
      name: "ApiArtifactsDriftError",
      files: [path.join(root, "docs/focusable/api.json")],
    });
    await generateApiArtifacts(generate);
    const checked = await generateApiArtifacts({ ...generate, mode: "check" });
    expect(checked.components[0]?.changed).toBe(false);
  });

  it("reads the directive from the entry itself when it forwards the dependency directly", async () => {
    const root = await facade({ "src/entry.ts": `export { Focusable } from "dep-aria";\n` });
    const result = await generateApiArtifacts(
      options(root, [
        {
          slug: "direct",
          entryFile: "src/entry.ts",
          exportNames: ["Focusable"],
          outputFile: "docs/direct/api.json",
        },
      ])
    );
    expect(result.components[0]?.parts[0]).toEqual({
      ...focusablePart,
      rsc: "server",
      sourcePath: "src/entry.ts",
    });
  });

  it.each([
    { form: "export * from the dependency", source: `"use client";\nexport * from "dep-aria";\n` },
    {
      form: "an imported binding exported by name",
      source: `"use client";\nimport { Focusable } from "dep-aria";\nexport { Focusable };\n`,
    },
    {
      form: "an authored value alias",
      source: `"use client";\nimport { Focusable as DepFocusable } from "dep-aria";\nexport const Focusable = DepFocusable;\n`,
    },
  ])("publishes a facade that forwards through $form from that facade", async ({ source }) => {
    const root = await facade({
      "src/entry.ts": `export { Focusable } from "./focusable/focusable";\n`,
      "src/focusable/focusable.tsx": source,
    });
    const result = await generateApiArtifacts(
      options(root, [
        {
          slug: "form",
          entryFile: "src/entry.ts",
          exportNames: ["Focusable"],
          outputFile: "docs/form/api.json",
        },
      ])
    );
    expect(result.components[0]?.parts).toEqual([focusablePart]);
  });

  it.each([
    { form: "export * from the dependency", source: `"use client";\nexport * from "dep-aria";\n` },
    {
      form: "an imported binding exported by name",
      source: `"use client";\nimport { Focusable } from "dep-aria";\nexport { Focusable };\n`,
    },
    {
      form: "an authored value alias",
      source: `"use client";\nimport { Focusable as DepFocusable } from "dep-aria";\nexport const Focusable = DepFocusable;\n`,
    },
  ])("keeps a $form facade prop-free when the dependency is selected", async ({ source }) => {
    const root = await facade({
      "src/entry.ts": `export { Focusable } from "./focusable/focusable";\n`,
      "src/focusable/focusable.tsx": source,
    });
    const result = await generateApiArtifacts({
      ...options(root, [
        {
          slug: "form",
          entryFile: "src/entry.ts",
          exportNames: ["Focusable"],
          outputFile: "docs/form/api.json",
        },
      ]),
      includeExternalTypes: ["dep-aria"],
    });
    expect(result.components[0]?.parts).toEqual([focusablePart]);
  });

  it.each(["src/barrel.ts", "src/entry.ts"])(
    "follows consecutive star exports from %s to the client facade",
    async (entryFile) => {
      const root = await facade({
        "src/entry.ts": `export { Focusable } from "./barrel";\n`,
        "src/barrel.ts": `export * from "./focusable/focusable";\n`,
        "src/focusable/focusable.tsx": `"use client";\nexport * from "dep-aria";\n`,
      });
      const result = await generateApiArtifacts(
        options(root, [{ ...focusableComponent, entryFile, exportNames: ["Focusable"] }])
      );
      expect(result.components[0]?.parts).toEqual([focusablePart]);
    }
  );

  it("publishes a member of a forwarded container from the module that aliases the container", async () => {
    const root = await facade({
      "src/entry.ts": `export { Group } from "./focusable/group";\n`,
      "src/focusable/group.tsx": `"use client";\nimport { Group as DepGroup } from "dep-aria";\nexport const Group = DepGroup;\n`,
    });
    const result = await generateApiArtifacts(
      options(root, [
        {
          slug: "group",
          entryFile: "src/entry.ts",
          exportNames: ["Group"],
          outputFile: "docs/group/api.json",
        },
      ])
    );
    expect(result.components[0]?.parts).toEqual([
      { ...focusablePart, name: "Group.Focusable", sourcePath: "src/focusable/group.tsx" },
    ]);
  });

  it("keeps a forwarded container member prop-free when the dependency is selected", async () => {
    const root = await facade({
      "src/entry.ts": `export { Group } from "./focusable/group";\n`,
      "src/focusable/group.tsx": `"use client";\nimport { Group as DepGroup } from "dep-aria";\nexport const Group = DepGroup;\n`,
    });
    const result = await generateApiArtifacts({
      ...options(root, [
        {
          slug: "group",
          entryFile: "src/entry.ts",
          exportNames: ["Group"],
          outputFile: "docs/group/api.json",
        },
      ]),
      includeExternalTypes: ["dep-aria"],
      allowedWarningCodes: ["unsupported-type-fallback"],
    });
    expect(result.components[0]?.parts).toEqual([
      { ...focusablePart, name: "Group.Focusable", sourcePath: "src/focusable/group.tsx" },
    ]);
  });

  it("still enriches a resolved local wrapper that accepts selected dependency props", async () => {
    const root = await facade({
      "src/wrapper.tsx": `"use client";
import { Focusable, type FocusableProps } from "dep-aria";
/** Local wrapper around dep-aria Focusable. */
export function Wrapper(props: FocusableProps) { return Focusable(props); }
`,
    });
    const result = await generateApiArtifacts({
      ...options(root, [
        {
          slug: "wrapper",
          entryFile: "src/wrapper.tsx",
          exportNames: ["Wrapper"],
          outputFile: "docs/wrapper/api.json",
        },
      ]),
      includeExternalTypes: ["dep-aria"],
    });
    expect(result.components[0]?.parts).toEqual([
      {
        name: "Wrapper",
        rsc: "client",
        sourcePath: "src/wrapper.tsx",
        props: [
          {
            name: "isDisabled",
            origin: { packageName: "dep-aria" },
            type: "boolean | undefined",
            shortType: null,
            defaultValue: null,
            description: "Whether the element is disabled.",
            required: false,
          },
        ],
        forwardedFrom: ["dep-aria"],
        forwardedCount: 1,
      },
    ]);
  });

  it("still rejects a declaration-only value the project itself declares", async () => {
    const root = await facade({
      "src/declared.d.ts": `export declare function DeclaredOnly(props: { label: string }): null;\n`,
      "src/entry.ts": `export { DeclaredOnly } from "./declared";\n`,
    });
    await expect(
      generateApiArtifacts(
        options(root, [
          {
            slug: "declared",
            entryFile: "src/entry.ts",
            exportNames: ["DeclaredOnly"],
            outputFile: "docs/declared/api.json",
          },
        ])
      )
    ).rejects.toThrow(/DeclaredOnly: could not recover the authored implementation \(no-implementation\)/u);
  });
});
