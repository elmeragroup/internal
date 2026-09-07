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

async function linkWorkspaceReact(root: string): Promise<void> {
  const reactRoot = path.dirname(require.resolve("react/package.json"));
  const typesRoot = path.dirname(require.resolve("@types/react/package.json"));
  await mkdir(path.join(root, "node_modules/@types"), { recursive: true });
  await symlink(reactRoot, path.join(root, "node_modules/react"));
  await symlink(typesRoot, path.join(root, "node_modules/@types/react"));
}

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "api-artifacts-source-"));
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
        skipLibCheck: false,
      },
      include: ["**/*.ts", "**/*.tsx"],
    })
  );
  for (const [relative, source] of Object.entries(files)) {
    const filePath = path.join(root, relative);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, source);
  }
  await linkWorkspaceReact(root);
  return root;
}

function options(
  projectRoot: string,
  components: readonly {
    slug: string;
    entryFile: string;
    exportNames: readonly string[];
    outputFile: string;
  }[]
) {
  return { projectRoot, tsconfigPath: "tsconfig.json", components };
}

describe("component implementation source", () => {
  it("recovers nested memo/forwardRef source, client status, and destructuring defaults", async () => {
    const root = await fixture({
      "nested.tsx": `"use client";
import { forwardRef, memo } from "react";

export type NestedProps = {
  /** Visible label. */
  label?: string;
};

export const NestedWrapped = memo(
  forwardRef<unknown, NestedProps>(function NestedWrapped({ label = "hello" }, _ref) {
    return label;
  }),
);
`,
    });
    const result = await generateApiArtifacts(
      options(root, [
        {
          slug: "nested",
          entryFile: "nested.tsx",
          exportNames: ["NestedWrapped"],
          outputFile: "docs/nested/api.json",
        },
      ])
    );
    const part = result.components[0]?.parts[0];
    expect(part).toMatchObject({
      name: "NestedWrapped",
      rsc: "client",
      sourcePath: "nested.tsx",
    });
    expect(part?.props).toEqual([
      {
        name: "label",
        origin: "declared",
        type: "string | undefined",
        shortType: null,
        defaultValue: '"hello"',
        description: "Visible label.",
        required: false,
      },
    ]);
    expect(part?.sourcePath).not.toMatch(/node_modules/u);
  });

  it.each([
    { name: "named import", expression: "memo(Render)" },
    { name: "namespace import", expression: "memo(impl.Render)" },
    { name: "object property wrapper", expression: "memo(components.Render)" },
    { name: "object property alias", expression: "components.Render" },
  ])("recovers source metadata through a $name", async ({ expression }) => {
    const root = await fixture({
      "render.ts": `"use client";
export type RenderProps = {
  /** Visible title. */
  title?: string;
};
export function Render({ title = "from-render" }: RenderProps) {
  return title;
}
`,
      "entry.ts": `import { memo } from "react";
import { Render } from "./render.ts";
import * as impl from "./render.ts";
const components = { Render };
export const ImportedWrapped = ${expression};
`,
    });
    const result = await generateApiArtifacts(
      options(root, [
        {
          slug: "imported",
          entryFile: "entry.ts",
          exportNames: ["ImportedWrapped"],
          outputFile: "docs/imported/api.json",
        },
      ])
    );
    const part = result.components[0]?.parts[0];
    expect(part).toMatchObject({
      name: "ImportedWrapped",
      rsc: "client",
      sourcePath: "render.ts",
    });
    expect(part?.props).toEqual([
      {
        name: "title",
        origin: "declared",
        type: "string | undefined",
        shortType: null,
        defaultValue: '"from-render"',
        description: "Visible title.",
        required: false,
      },
    ]);
  });

  it("uses the implementation of an overload with a semicolon-free object return type", async () => {
    const root = await fixture({
      "render.ts": `"use client";
export type Props = {
  /** Visible label. */
  label?: string;
};
export function Overloaded(props: Props): { type: "span"; props: { children: string }; key: null }
export function Overloaded({ label = "actual" }: Props) {
  return { type: "span", props: { children: label }, key: null };
}
`,
      "entry.ts": `export { Overloaded } from "./render.ts";`,
    });
    const result = await generateApiArtifacts(
      options(root, [
        {
          slug: "overloaded",
          entryFile: "entry.ts",
          exportNames: ["Overloaded"],
          outputFile: "docs/overloaded/api.json",
        },
      ])
    );
    expect(result.components[0]?.parts[0]).toEqual({
      name: "Overloaded",
      rsc: "client",
      sourcePath: "render.ts",
      props: [
        {
          name: "label",
          origin: "declared",
          type: "string | undefined",
          shortType: null,
          defaultValue: '"actual"',
          description: "Visible label.",
          required: false,
        },
      ],
      forwardedCount: 0,
      forwardedFrom: [],
    });
  });

  it("preserves outer-property defaults on nested bindings for a direct component", async () => {
    const root = await fixture({
      "direct.ts": `export type DirectProps = {
  /** Nested options. */
  options?: { enabled?: boolean };
};
export function Direct({ options: { enabled } = {} }: DirectProps) {
  return enabled;
}
`,
    });
    const result = await generateApiArtifacts(
      options(root, [
        {
          slug: "direct",
          entryFile: "direct.ts",
          exportNames: ["Direct"],
          outputFile: "docs/direct/api.json",
        },
      ])
    );
    expect(result.components[0]?.parts[0]).toMatchObject({
      name: "Direct",
      rsc: "server",
      sourcePath: "direct.ts",
    });
    expect(result.components[0]?.parts[0]?.props).toEqual([
      {
        name: "options",
        origin: "declared",
        type: "{ enabled?: boolean | undefined; } | undefined",
        shortType: "Union",
        defaultValue: "{}",
        description: "Nested options.",
        required: false,
      },
    ]);
  });

  it("recovers zero-prop wrappers and wrapped outer-property defaults", async () => {
    const root = await fixture({
      "wrapped.tsx": `"use client";
import { memo } from "react";

export type OptionsProps = {
  /** Nested options. */
  options?: { enabled?: boolean };
};

export const EmptyWrapped = memo(function EmptyWrapped() {
  return null;
});

export const OptionsWrapped = memo(function OptionsWrapped({ options: { enabled } = {} }: OptionsProps) {
  return enabled;
});
`,
    });
    const result = await generateApiArtifacts(
      options(root, [
        {
          slug: "wrapped",
          entryFile: "wrapped.tsx",
          exportNames: ["EmptyWrapped", "OptionsWrapped"],
          outputFile: "docs/wrapped/api.json",
        },
      ])
    );
    expect(result.components[0]?.parts.map((part) => part.name)).toEqual(["EmptyWrapped", "OptionsWrapped"]);
    expect(result.components[0]?.parts[0]).toMatchObject({
      name: "EmptyWrapped",
      rsc: "client",
      sourcePath: "wrapped.tsx",
      props: [],
    });
    expect(result.components[0]?.parts[1]).toMatchObject({
      name: "OptionsWrapped",
      rsc: "client",
      sourcePath: "wrapped.tsx",
    });
    expect(result.components[0]?.parts[1]?.props).toEqual([
      {
        name: "options",
        origin: "declared",
        type: "{ enabled?: boolean | undefined; } | undefined",
        shortType: "Union",
        defaultValue: "{}",
        description: "Nested options.",
        required: false,
      },
    ]);
  });

  it("fails for unknown wrappers instead of publishing React declaration metadata", async () => {
    const root = await fixture({
      "custom.ts": `export type Props = {
  /** Visible label. */
  label?: string;
};
function wrap<T>(value: T): T {
  return value;
}
export const CustomWrapped = wrap(function CustomWrapped({ label = "custom" }: Props) {
  return label;
});
`,
    });
    await expect(
      generateApiArtifacts(
        options(root, [
          {
            slug: "custom",
            entryFile: "custom.ts",
            exportNames: ["CustomWrapped"],
            outputFile: "docs/custom/api.json",
          },
        ])
      )
    ).rejects.toThrow(
      /CustomWrapped: could not recover the authored implementation \(unsupported-wrapper\)/u
    );
  });

  it("does not write artifacts when source inspection cannot recover an implementation", async () => {
    const root = await fixture({
      "button.ts": `export type Props = {
  /** Visible label. */
  label: string;
};
export function Button({ label }: Props) {
  return label;
}
`,
      "declared.d.ts": `export type DeclaredProps = {
  /** Visible label. */
  label: string;
};
export function DeclaredOnly(props: DeclaredProps): { type: "span"; props: { children: string }; key: null }
`,
    });
    const output = path.join(root, "docs/button/api.json");
    await generateApiArtifacts(
      options(root, [
        {
          slug: "button",
          entryFile: "button.ts",
          exportNames: ["Button"],
          outputFile: "docs/button/api.json",
        },
      ])
    );
    await writeFile(output, "keep me\n");
    await expect(
      generateApiArtifacts(
        options(root, [
          {
            slug: "button",
            entryFile: "button.ts",
            exportNames: ["Button"],
            outputFile: "docs/button/api.json",
          },
          {
            slug: "declared",
            entryFile: "declared.d.ts",
            exportNames: ["DeclaredOnly"],
            outputFile: "docs/declared/api.json",
          },
        ])
      )
    ).rejects.toThrow(/DeclaredOnly: could not recover the authored implementation \(no-implementation\)/u);
    expect(await readFile(output, "utf8")).toBe("keep me\n");
  });
});
