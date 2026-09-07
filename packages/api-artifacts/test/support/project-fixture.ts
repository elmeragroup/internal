import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

const require = createRequire(import.meta.url);

export type ProjectFixtureOptions = {
  /** Temporary directory prefix, so a leaked root names the suite that made it. */
  readonly prefix: string;
  /** `tsconfig.json` `include` globs. */
  readonly include: readonly string[];
  /** Whether dependency declarations are type-checked; facades over stub packages skip them. */
  readonly skipLibCheck?: boolean;
};

export type ComponentFixtureRequest = {
  readonly slug: string;
  readonly entryFile: string;
  readonly exportNames: readonly string[];
  readonly outputFile: string;
};

/**
 * A temporary React project per test: strict Bundler-resolution `tsconfig.json`,
 * the given files, and the workspace `react` plus `@types/react` symlinked in.
 * Roots are removed after each test of the suite that created the helper.
 */
export function projectFixtures(options: ProjectFixtureOptions) {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });
  return async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), options.prefix));
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
          skipLibCheck: options.skipLibCheck ?? false,
        },
        include: options.include,
      })
    );
    for (const [relative, source] of Object.entries(files)) {
      const filePath = path.join(root, relative);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, source);
    }
    await linkWorkspaceReact(root);
    return root;
  };
}

/** `generateApiArtifacts` options for one fixture root. */
export function artifactOptions(projectRoot: string, components: readonly ComponentFixtureRequest[]) {
  return { projectRoot, tsconfigPath: "tsconfig.json", components };
}

async function linkWorkspaceReact(root: string): Promise<void> {
  const reactRoot = path.dirname(require.resolve("react/package.json"));
  const typesRoot = path.dirname(require.resolve("@types/react/package.json"));
  await mkdir(path.join(root, "node_modules/@types"), { recursive: true });
  await symlink(reactRoot, path.join(root, "node_modules/react"));
  await symlink(typesRoot, path.join(root, "node_modules/@types/react"));
}
