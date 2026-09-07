import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openLibraryProject, readRscStatus } from "../src/checker.ts";
import type { RscStatus } from "../src/model.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type StatusCase = {
  readonly name: string;
  readonly file: string;
  readonly source: string;
  readonly expected: RscStatus;
};

const cases: readonly StatusCase[] = [
  {
    name: "double quotes",
    file: "double-quote.ts",
    source: `"use client";\nexport const value = 1;\n`,
    expected: "client",
  },
  {
    name: "single quotes",
    file: "single-quote.ts",
    source: `'use client';\nexport const value = 1;\n`,
    expected: "client",
  },
  {
    name: "optional semicolon",
    file: "no-semicolon.ts",
    source: `"use client"\nexport const value = 1;\n`,
    expected: "client",
  },
  {
    name: "leading blank lines",
    file: "leading-blanks.ts",
    source: `\n\n"use client";\nexport const value = 1;\n`,
    expected: "client",
  },
  {
    name: "leading block comment",
    file: "leading-block-comment.ts",
    source: `/* header */\n"use client";\nexport const value = 1;\n`,
    expected: "client",
  },
  {
    name: "leading line comment",
    file: "leading-line-comment.ts",
    source: `// header\n"use client";\nexport const value = 1;\n`,
    expected: "client",
  },
  {
    name: "trailing line comment",
    file: "trailing-line-comment.ts",
    source: `"use client"; // comment\nexport const value = 1;\n`,
    expected: "client",
  },
  {
    name: "trailing block comment",
    file: "trailing-block-comment.ts",
    source: `"use client"; /* comment */\nexport const value = 1;\n`,
    expected: "client",
  },
  {
    name: "same-line following export",
    file: "same-line-export.ts",
    source: `"use client"; export const value = 1;\n`,
    expected: "client",
  },
  {
    name: "preceding other string directives",
    file: "preceding-string-directive.ts",
    source: `"use strict";\n"use client";\nexport const value = 1;\n`,
    expected: "client",
  },
  {
    name: "BOM",
    file: "bom.ts",
    source: `\uFEFF"use client";\nexport const value = 1;\n`,
    expected: "client",
  },
  {
    name: "CRLF",
    file: "crlf.ts",
    source: `"use client";\r\nexport const value = 1;\r\n`,
    expected: "client",
  },
  {
    name: "valid shebang",
    file: "shebang.ts",
    source: `#!/usr/bin/env node\n"use client";\nexport const value = 1;\n`,
    expected: "client",
  },
  { name: "empty module", file: "empty.ts", source: "", expected: "server" },
  {
    name: "import before a later client string",
    file: "import-before.ts",
    source: `import { value as imported } from "./dep";\n"use client";\nexport const value = imported;\n`,
    expected: "server",
  },
  {
    name: "declaration before a later client string",
    file: "declaration-before.ts",
    source: `export const earlier = 1;\n"use client";\nexport const later = 2;\n`,
    expected: "server",
  },
  {
    name: "template literal",
    file: "template-literal.ts",
    source: "`use client`;\nexport const value = 1;\n",
    expected: "server",
  },
  {
    name: "parenthesized string",
    file: "parenthesized.ts",
    source: `("use client");\nexport const value = 1;\n`,
    expected: "server",
  },
  {
    name: "comment-shaped string",
    file: "comment-shaped-string.ts",
    source: `"use /* comment */client";\nexport const value = 1;\n`,
    expected: "server",
  },
  {
    name: "line-comment-like content inside a string",
    file: "line-comment-in-string.ts",
    source: `"use client // still a string";\nexport const value = 1;\n`,
    expected: "server",
  },
  {
    name: "escaped directive spelling",
    file: "escaped-directive.ts",
    source: `"use\\x20client";\nexport const value = 1;\n`,
    expected: "server",
  },
  {
    name: "empty statement before the string",
    file: "empty-statement.ts",
    source: `;\n"use client";\nexport const value = 1;\n`,
    expected: "server",
  },
  {
    name: "string continued by a call on the next line",
    file: "continuation-call.ts",
    source: `"use client"\n();\nexport const value = 1;\n`,
    expected: "server",
  },
];

describe("readRscStatus", () => {
  it("classifies directive prologues from parsed syntax", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "api-artifacts-rsc-"));
    roots.push(root);
    await writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, types: [], module: "ESNext", moduleResolution: "Bundler" },
        include: ["*.ts"],
      })
    );
    await writeFile(path.join(root, "dep.ts"), "export const value = 1;\n");
    for (const testCase of cases) {
      await writeFile(path.join(root, testCase.file), testCase.source);
    }
    const context = openLibraryProject(path.resolve(root, "tsconfig.json"), root);
    try {
      for (const testCase of cases) {
        const absolutePath = path.resolve(root, testCase.file);
        const sourceFile = context.program.getSourceFile(absolutePath);
        if (sourceFile === undefined) {
          throw new Error(`${testCase.name}: missing source file ${absolutePath}`);
        }
        expect(readRscStatus(sourceFile), testCase.name).toBe(testCase.expected);
      }
    } finally {
      context.close();
    }
  });
});
