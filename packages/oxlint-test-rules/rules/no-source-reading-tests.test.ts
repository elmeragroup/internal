import { ruleTester } from "../shared/rule-tester.ts";
import { noSourceReadingTests } from "./no-source-reading-tests.ts";

/** A path joined to itself down a chain, then a code file under it. */
function doubledPath(depth: number): string {
  return [
    'const p0 = join(root, "src");',
    ...Array.from({ length: depth }, (_, index) => `const p${index + 1} = join(p${index}, p${index});`),
    `readFileSync(join(p${depth}, "button.ts"));`,
  ].join("\n");
}

/** A list spread-pushed from the one before it twice, down a chain, starting from a code listing. */
function doubledPushes(depth: number): string {
  return [
    'const v0 = readdirSync(dir).filter((f) => f.endsWith(".ts"));',
    ...Array.from(
      { length: depth },
      (_, index) => `const v${index + 1} = [];\nv${index + 1}.push(...v${index}, ...v${index});`
    ),
    `for (const f of v${depth}) readFileSync(f);`,
  ].join("\n");
}

/** A recursive walker that keeps names with `extension` and spreads in what each subdirectory's walk keeps. */
function recursiveWalker(extension: string): string {
  return `function walk(d) {\n  const out = [];\n  for (const name of readdirSync(d)) {\n    if (name.endsWith("${extension}")) out.push(name);\n    else out.push(...walk(join(d, name)));\n  }\n  return out;\n}\nfor (const f of walk(root)) readFileSync(f);`;
}

/** A helper walker that pushes the joined path of each name with `extension`. */
function collectingWalker(extension: string): string {
  return `function collect(dir) {\n  const files = [];\n  for (const name of readdirSync(dir)) {\n    if (name.endsWith("${extension}")) files.push(join(dir, name));\n  }\n  return files;\n}\nfor (const f of collect(root)) readFileSync(f);`;
}

/** A walk of `dir` whose filter keeps what `filter` keeps, then `steps` on the list, then a read of each file. */
function walkFiltered(filter: string, steps = ""): string {
  return `for (const f of readdirSync(dir).filter((f) => ${filter})${steps}) readFileSync(f);`;
}

ruleTester.run("no-source-reading-tests", noSourceReadingTests, {
  valid: [
    // A filter that keeps data files keeps no code.
    walkFiltered('extname(f) === ".json"'),
    walkFiltered('[".json", ".md"].includes(extname(f))'),
    walkFiltered("f.match(/\\.json$/)"),
    walkFiltered('f.endsWith(".log") || f.endsWith(".json")'),
    // A pattern that matches every file name keeps nothing provable.
    "for (const f of readdirSync(dir).filter((f) => /.*/.test(f))) readFileSync(f);",
    // Hang: a path past the traversal's budget is unknown.
    doubledPath(25),
    // A selector that inspects another value than the element keeps nothing.
    'const format = "x.ts";\nfor (const name of readdirSync(logDir).filter((name) => format.endsWith(".ts"))) readFileSync(name);',
    // `resolve` keeps a temporary directory when every later segment is a known relative one.
    'readFileSync(resolve(tmpdir(), "out", "main.ts"));',
    // `new URL(spec, base)` names the spec's file in the base's directory.
    'readFileSync(new URL("./data.json", new URL("./test.ts", import.meta.url)));',
    // Data the test wrote, read or written through a helper.
    'function readFixture(p) {\n  return readFileSync(p, "utf8");\n}\nit("x", () => {\n  const file = join(dir, "fixture.ts");\n  writeFileSync(file, "a");\n  expect(readFixture(file)).toContain("a");\n});',
    'function writeFixture(p) {\n  writeFileSync(p, "a");\n}\nit("x", () => {\n  const file = join(dir, "fixture.ts");\n  writeFixture(file);\n  expect(readFileSync(file, "utf8")).toContain("a");\n});',
    // A filter that keeps logs and excludes code keeps no code.
    'for (const f of readdirSync(dir).filter((f) => f.endsWith(".log") && !f.endsWith(".ts"))) readFileSync(f);',
    'const files = readdirSync(dir).filter((f) => !f.endsWith(".ts"));\nfor (const f of files) readFileSync(f);',
    // A code extension the walk excludes, through a list, is no filter that keeps code.
    'const CODE = [".ts", ".tsx"];\nconst logs = readdirSync(dir).filter((f) => f.endsWith(".log") && !CODE.some((e) => f.endsWith(e)));\nfor (const f of logs) readFileSync(f);',
    // Data the test wrote is test data, whatever its extension.
    'it("transforms", () => {\n  const file = join(dir, "fixture.ts");\n  writeFileSync(file, "export const a = 1;");\n  transform(file);\n  expect(readFileSync(file, "utf8")).toContain("a");\n});',
    'it("emits", () => {\n  const dir = mkdtempSync(join(tmpdir(), "emit-"));\n  build(dir);\n  expect(readFileSync(join(dir, "out.js"), "utf8")).toContain("a");\n});',
    // `JSON.parse` past await consumes the read.
    'const data = JSON.parse(await readFile(join(root, "src/data.ts"), "utf8"));',
    // `JSON.parse` past an assertion consumes the read.
    'const data = JSON.parse(readFileSync(join(root, "src/data.ts")) as string);',
    // A computed template keeps its literal suffix, which names the file: a log beside a code entry.
    'function logOf(entry) {\n  return readFileSync(join(dir, `${entry}.jsonl`), "utf8");\n}\nlogOf("token-process.ts");',
    // An unknown spread nested in a known one leaves every later index unknown.
    'readFileSync([...[...unknownList], "source.ts"][0]);',
    // A static template is classified as the whole string, its parts in order.
    'readFileSync(`${"manifest.ts"}.json`);',
    // Hang: a binding that refers to itself resolves to nothing and cannot loop the walk.
    "var files = files;\nfor (const file of files) readFileSync(file);",
    // A bracketed static key narrows like a dotted one.
    'function paths() {\n  return { logs: readdirSync(logDir), modules: globSync("*.ts") };\n}\nfor (const log of paths()["logs"]) readFileSync(log);',
    // A reassigned walk binding resolves to nothing, not to its old initializer.
    'let files = globSync("*.ts");\nfiles = globSync("*.log");\nfor (const file of files) readFileSync(file);',
    // Array spreads are expanded before indexing.
    'readFileSync([...["src/button.tsx", "b.json"], "c.json"][1]);',
    // An alias or destructured key of the log property is judged by that property alone.
    'function paths() {\n  return { logs: readdirSync(logDir), modules: globSync("*.ts") };\n}\nconst logs = paths().logs;\nfor (const log of logs) readFileSync(log);',
    'function paths() {\n  return { logs: readdirSync(logDir), modules: globSync("*.ts") };\n}\nconst { logs } = paths();\nfor (const log of logs) readFileSync(log);',
    'const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));',
    'const css = readFileSync(new URL("chart.css", import.meta.url), "utf8");',
    'const md = readFileSync(join(outDir, `${slug}.md`), "utf8");',
    'import themeCss from "../styles/theme.css?raw";',
    'const sheet = await import("../styles/theme.css?raw");',
    'const types = readFileSync(join(dist, "index.d.ts"), "utf8");',
    // A computed path that no code walk supplies reads data the test wrote.
    'const log = readFileSync(logFile, "utf8");',
    'const records = await readFile(path.join(cwd, "fake-server.log"), "utf8");',
    'const EXTENSIONS = [".ts"];\nconst api = JSON.parse(readFileSync(apiFile, "utf8"));\nreaddirSync(dir);',
    'expect(manifest.sideEffects).toEqual(["**/*.css"]);\nfor (const f of readdirSync(dir)) readFileSync(f);',
    // A path looked up from data, beside a code walk, names that data's file.
    'const EXTENSIONS = [".ts"];\nreaddirSync(dir);\nconst page = readFileSync(paths(slug).pageFile, "utf8");',
    'import { compiledCssPath } from "./paths";\nconst EXTENSIONS = [".ts"];\nreaddirSync(dir);\nreadFileSync(compiledCssPath, "utf8");',
    'const EXTENSIONS = [".ts"];\nreaddirSync(dir);\nreadFileSync(createRequire(import.meta.url).resolve("@example/ui/themes.css"), "utf8");',
    // The property read decides the evidence, not the whole object returned.
    'function paths() {\n  return { logs: readdirSync(logDir), modules: globSync("*.ts") };\n}\nfor (const log of paths().logs) readFileSync(log);',
    // `JSON.parse` under its real name only.
    'const pkg = JSON.parse(readFileSync(join(root, "src/manifest.ts"), "utf8"));',
    // An unrelated listing of code files does not make a helper's log read a source read.
    'it("lists the modules", () => {\n  expect(readdirSync(src).filter((name) => name.endsWith(".ts"))).toContain("button.ts");\n});\nfunction readLog(file) {\n  return readFileSync(file, "utf8");\n}\nconst logPath = join(tmp, "server.log");\nit("logs", () => {\n  expect(readLog(logPath)).toContain("ready");\n});',
    // A flatMap that hands back each name, or a spread push of a data listing, keeps what the listing keeps.
    walkFiltered('f.endsWith(".json")', ".flatMap((f) => [f])"),
    'const all = [];\nall.push(...readdirSync(dir).filter((f) => f.endsWith(".json")));\nfor (const f of all) readFileSync(f);',
    // A flatMap that returns more than the name, or a spread of a value that is no list the rule follows, proves nothing.
    walkFiltered('f.endsWith(".ts")', ".flatMap((f) => [f, other])"),
    walkFiltered('f.endsWith(".ts")', ".flatMap((f) => lookup(f))"),
    walkFiltered('f.endsWith(".ts")', ".flatMap((f) => [...f])"),
    // A map to one-name arrays is a list of arrays, not of names.
    walkFiltered('f.endsWith(".ts")', ".map((f) => [f])"),
    // A walker that keeps data files, through its own recursion or a helper that joins each name.
    recursiveWalker(".json"),
    collectingWalker(".json"),
    // Hang: a list spread into itself, and a doubled spread-push chain past the budget, prove nothing.
    "const all = [];\nall.push(...all);\nfor (const f of all) readFileSync(f);",
    doubledPushes(25),
    "const all = [];\nall.push(...things);\nfor (const f of all) readFileSync(f);",
    'const all = [];\nall.push(...readdirSync(dir).filter((f) => f.endsWith(".ts")), ...things);\nfor (const f of all) readFileSync(f);',
    // A pattern anchored at the end keeps what its trailing extension names: a data file here.
    walkFiltered("/fixture\\.json$/.test(f)"),
    walkFiltered('/^report\\.(json|md)$/.test(f) && f.endsWith(".ts")'),
    // A declaration file is no code module.
    walkFiltered("/^types\\.d\\.ts$/.test(f)"),
    walkFiltered("/(?:\\.d)\\.ts$/.test(f)"),
    walkFiltered('f.endsWith(".ts") && /\\.d\\.ts$/.test(f)'),
    walkFiltered("/\\.tsx?$/.test(f) && /\\.d\\.ts$/.test(f)"),
    walkFiltered('f.endsWith(".ts")', ".filter((f) => /\\.d\\.ts$/.test(f))"),
    walkFiltered('f.endsWith(".ts") && /^types\\.d\\.ts$/.test(f)'),
    // Hang: a stem nested past the reader's depth is unreadable.
    walkFiltered(`/button${"(?:".repeat(10_000)}\\.ts${")".repeat(10_000)}$/.test(f)`),
    // A pattern not anchored at the end, or anchored per line, keeps nothing provable.
    walkFiltered("/button\\.tsx?/.test(f)"),
    walkFiltered("/button\\.tsx?$/m.test(f)"),
    walkFiltered("/button\\.tsx?$|readme/.test(f)"),
  ],
  invalid: [
    // A pattern with a stem keeps the code its trailing extension names.
    { code: walkFiltered("/button\\.tsx?$/.test(f)"), errors: [{ messageId: "source" }] },
    { code: walkFiltered("f.match(/^index\\.(ts|tsx)$/)"), errors: [{ messageId: "source" }] },
    { code: walkFiltered("/^view-[a-z]+\\.m?js$/.test(f)"), errors: [{ messageId: "source" }] },
    { code: walkFiltered("/BUTTON\\.TSX?$/i.test(f)"), errors: [{ messageId: "source" }] },
    // A prefix before a wildcard does not hide the code extension the pattern ends with.
    { code: walkFiltered("/^src\\/.*\\.tsx?$/.test(f)"), errors: [{ messageId: "source" }] },
    { code: walkFiltered("/(?:^|\\/)__tests__\\/.*\\.[jt]sx?$/.test(f)"), errors: [{ messageId: "source" }] },
    // A flatMap that hands back each name, or a spread push of a code listing, keeps code.
    { code: walkFiltered('f.endsWith(".ts")', ".flatMap((f) => [f])"), errors: [{ messageId: "source" }] },
    // Control: a flatMap that returns the name itself, which keeps the name as a map does.
    { code: walkFiltered('f.endsWith(".ts")', ".flatMap((f) => f)"), errors: [{ messageId: "source" }] },
    // A walker that keeps code files, through its own recursion or a helper that joins each name.
    { code: recursiveWalker(".ts"), errors: [{ messageId: "source" }] },
    { code: collectingWalker(".ts"), errors: [{ messageId: "source" }] },
    // A doubled spread-push chain within the budget keeps its listing's code.
    { code: doubledPushes(3), errors: [{ messageId: "source" }] },
    {
      code: 'const all = [];\nall.push(...readdirSync(dir).filter((f) => f.endsWith(".ts")));\nfor (const f of all) readFileSync(f);',
      errors: [{ messageId: "source" }],
    },
    // Every filter shape that keeps a code extension keeps code.
    { code: walkFiltered("f.match(/\\.tsx?$/)"), errors: [{ messageId: "source" }] },
    { code: walkFiltered('extname(f) === ".ts"'), errors: [{ messageId: "source" }] },
    { code: walkFiltered('[".ts", ".tsx"].includes(extname(f))'), errors: [{ messageId: "source" }] },
    { code: walkFiltered('f.endsWith(".log") || f.endsWith(".ts")'), errors: [{ messageId: "source" }] },
    { code: walkFiltered('f.toLowerCase().endsWith(".ts")'), errors: [{ messageId: "source" }] },
    { code: walkFiltered('`${f}`.endsWith(".ts")'), errors: [{ messageId: "source" }] },
    // Reordering and slicing a list keeps what it holds.
    {
      code: walkFiltered('f.endsWith(".ts")', ".sort().slice(0, 3).reverse()"),
      errors: [{ messageId: "source" }],
    },
    // A list mapped to full paths, or concatenated with another, keeps its code files.
    {
      code: 'const files = readdirSync(dir)\n  .filter((f) => f.endsWith(".ts"))\n  .map((name) => join(dir, name));\nfor (const f of files) readFileSync(f);',
      errors: [{ messageId: "source" }],
    },
    {
      code: 'const logs = readdirSync(dir).filter((f) => f.endsWith(".log"));\nconst code = readdirSync(dir).filter((f) => f.endsWith(".ts"));\nfor (const f of logs.concat(code)) readFileSync(f);',
      errors: [{ messageId: "source" }],
    },
    // A guard inside the loop, by `&&` or a conditional, selects code like a filter.
    {
      code: 'for (const f of readdirSync(dir)) f.endsWith(".ts") && readFileSync(f);',
      errors: [{ messageId: "source" }],
    },
    {
      code: 'for (const f of readdirSync(dir)) f.endsWith(".ts") ? readFileSync(f) : undefined;',
      errors: [{ messageId: "source" }],
    },
    // Reviewer repro: a Dirent walk's `.name` is the walked file name, with its guard.
    {
      code: 'for (const entry of readdirSync(src, { withFileTypes: true })) {\n  if (entry.name.endsWith(".ts")) readFileSync(join(src, entry.name));\n}',
      errors: [{ messageId: "source" }],
    },
    {
      code: 'for (const entry of readdirSync(src, { withFileTypes: true })) {\n  if (entry.name.endsWith(".ts")) readFileSync(join(entry.parentPath, entry.name));\n}',
      errors: [{ messageId: "source" }],
    },
    // Control: the plain-string walk reports too.
    {
      code: 'for (const name of readdirSync(src)) {\n  if (name.endsWith(".ts")) readFileSync(join(src, name));\n}',
      errors: [{ messageId: "source" }],
    },
    // One array literal whose spread alternatives hold different elements keeps code in either order.
    {
      code: 'for (const f of [...(flag ? ["data.json"] : ["source.ts"])]) readFileSync(f);',
      errors: [{ messageId: "source" }],
    },
    {
      code: 'for (const f of [...(flag ? ["source.ts"] : ["data.json"])]) readFileSync(f);',
      errors: [{ messageId: "source" }],
    },
    // A pattern is judged by what it matches, however it is spelled.
    {
      code: "for (const f of readdirSync(dir).filter((f) => /\\.(?:[cm]?[jt]sx?)$/u.test(f))) readFileSync(f);",
      errors: [{ messageId: "source" }],
    },
    // A doubled path within the budget still names its code file.
    { code: doubledPath(3), errors: [{ messageId: "source" }] },
    // An absolute or unknown later `resolve` segment drops the temporary directory, and so does `..`.
    {
      code: 'readFileSync(resolve(tmpdir(), process.cwd(), "src/main.ts"));',
      errors: [{ messageId: "source" }],
    },
    { code: 'readFileSync(resolve(tmpdir(), "/repo/src/main.ts"));', errors: [{ messageId: "source" }] },
    { code: 'readFileSync(join(tmpdir(), "../../src/main.ts"));', errors: [{ messageId: "source" }] },
    // The spec names the file, in the base's directory.
    {
      code: 'readFileSync(new URL("./button.ts", new URL("./fixtures/", import.meta.url)));',
      errors: [{ messageId: "source" }],
    },
    // A reader helper still reports at a call that passes a code path the test did not write.
    {
      code: 'function readFixture(p) {\n  return readFileSync(p, "utf8");\n}\nit("x", () => {\n  const file = join(dir, "fixture.ts");\n  writeFileSync(file, "a");\n  readFixture(file);\n  expect(readFixture(join(root, "src/button.ts"))).toContain("a");\n});',
      errors: [{ messageId: "source", line: 2 }],
    },
    // A filter that keeps code, declaration files aside, keeps code.
    {
      code: 'for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))) readFileSync(f);',
      errors: [{ messageId: "source" }],
    },
    // A path the test wrote does not cover a different code path it reads.
    {
      code: 'it("x", () => {\n  const file = join(dir, "fixture.ts");\n  writeFileSync(file, "a");\n  expect(readFileSync(join(root, "src/button.ts"), "utf8")).toContain("a");\n});',
      errors: [{ messageId: "source" }],
    },
    // A list a helper fills by push is no empty list: the walk is the helper's code.
    {
      code: 'const EXTENSIONS = [".ts"];\nfunction sourceFiles(dir) {\n  const files = [];\n  for (const entry of readdirSync(dir)) if (EXTENSIONS.some((e) => entry.endsWith(e))) files.push(entry);\n  return files;\n}\nfor (const file of sourceFiles(src)) readFileSync(file);',
      errors: [{ messageId: "source" }],
    },
    // `trim` reshapes a literal code path.
    {
      code: 'readFileSync("src/button.ts".trim());',
      errors: [{ messageId: "source" }],
    },
    // `concat` assembles a code path.
    {
      code: 'readFileSync("src/button".concat(".ts"));',
      errors: [{ messageId: "source" }],
    },
    // A computed template's literal suffix names a code module.
    {
      code: 'for (const name of names) readFileSync(join(dir, `${slug(name)}.ts`), "utf8");',
      errors: [{ messageId: "source" }],
    },
    // The known prefix before an unknown tail still indexes.
    { code: 'readFileSync([...["src/a.ts"], ...unknownList][0]);', errors: [{ messageId: "source" }] },
    // The assembled string ends in a code extension.
    { code: 'readFileSync(`${"manifest.json"}.ts`);', errors: [{ messageId: "source" }] },
    // A path that may be a code module, in either return order.
    {
      code: 'function pick() {\n  if (flag) return "src/button.tsx";\n  return "a.json";\n}\nreadFileSync(pick());',
      errors: [{ messageId: "source" }],
    },
    // The bracketed code-walk property.
    {
      code: 'function paths() {\n  return { logs: readdirSync(logDir), modules: globSync("*.ts") };\n}\nfor (const file of paths()["modules"]) readFileSync(file);',
      errors: [{ messageId: "source" }],
    },
    // A string-literal key in a destructuring pattern.
    {
      code: 'import * as fs from "node:fs";\nconst { "readFileSync": read } = fs;\nread("src/button.tsx", "utf8");',
      errors: [{ messageId: "source" }],
    },
    // The expanded index lands on the code path.
    {
      code: 'readFileSync([...["a.json", "src/button.tsx"], "b.json"][1]);',
      errors: [{ messageId: "source" }],
    },
    // A path a local function returns.
    {
      code: 'function source() {\n  return "button.tsx";\n}\nreadFileSync(source());',
      errors: [{ messageId: "source" }],
    },
    {
      code: 'const path = () => "./button.tsx";\nreadFileSync(path(), "utf8");',
      errors: [{ messageId: "source" }],
    },
    // The destructured code-walk property still reads source.
    {
      code: 'function paths() {\n  return { logs: readdirSync(logDir), modules: globSync("*.ts") };\n}\nconst { modules } = paths();\nfor (const file of modules) readFileSync(file);',
      errors: [{ messageId: "source" }],
    },
    // A reader destructured from a namespace import.
    {
      code: 'import * as fs from "node:fs";\nconst { readFileSync: read } = fs;\nread("src/button.tsx", "utf8");',
      errors: [{ messageId: "source" }],
    },
    {
      code: 'expect(readFileSync(join(packageRoot, "src/index.ts"), "utf8")).not.toContain("./flags");',
      errors: [{ messageId: "source" }],
    },
    {
      code: 'const ROSTER = path.join(librarySrc, "icons/roster.ts");\nconst source = readFileSync(ROSTER, "utf8");',
      errors: [{ messageId: "source" }],
    },
    { code: 'import source from "./button.tsx?raw";', errors: [{ messageId: "source" }] },
    // The dynamic form of a raw import.
    {
      code: 'const { default: source } = await import("./button.tsx?raw");',
      errors: [{ messageId: "source" }],
    },
    {
      code: 'const text = await fs.promises.readFile(new URL("./dialog.tsx", import.meta.url), "utf8");',
      errors: [{ messageId: "source" }],
    },
    // A renamed import of the reader.
    {
      code: 'import { readFileSync as read } from "node:fs";\nexpect(read("src/button.tsx", "utf8")).toContain("forwardRef");',
      errors: [{ messageId: "source" }],
    },
    {
      code: 'import * as fs from "node:fs";\nconst read = fs.readFileSync;\nread(join(root, "src/button.tsx"), "utf8");',
      errors: [{ messageId: "source" }],
    },
    // A directory walk filtered to code files reads each one's text.
    {
      code: 'const files = readdirSync(src).filter((file) => file.endsWith(".tsx"));\nfor (const file of files) expect(readFileSync(file, "utf8")).not.toMatch(/use client/);',
      errors: [{ messageId: "source" }],
    },
    {
      code: 'const modules = globSync("src/**").filter((file) => /\\.tsx?$/.test(file));\nconst sources = modules.map((file) => readFileSync(file, "utf8"));',
      errors: [{ messageId: "source" }],
    },
    {
      code: 'const EXTENSIONS = [".ts", ".tsx"];\nfunction walk(dir) {\n  return readdirSync(dir).filter((entry) => EXTENSIONS.some((e) => entry.endsWith(e)));\n}\nfor (const file of walk(src)) readFileSync(file, "utf8");',
      errors: [{ messageId: "source" }],
    },
    // The property read is the code walk.
    {
      code: 'function paths() {\n  return { logs: readdirSync(logDir), modules: globSync("*.ts") };\n}\nfor (const file of paths().modules) readFileSync(file);',
      errors: [{ messageId: "source" }],
    },
    // A literal source path through a reader helper.
    {
      code: 'function readSource(file) {\n  return readFileSync(file, "utf8");\n}\nreadSource("./button.tsx");',
      errors: [{ messageId: "source" }],
    },
    {
      code: 'const readSource = (file) => readFileSync(join(root, file), "utf8");\nconst BUTTON = "src/button.tsx";\nexpect(readSource(BUTTON)).toContain("ref");',
      errors: [{ messageId: "source" }],
    },
    // Another library's parse is no JSON exemption.
    {
      code: 'import { parse } from "@babel/parser";\nparse(readFileSync("src/button.tsx", "utf8"));',
      errors: [{ messageId: "source" }],
    },
    // A helper's parameter, supplied by a code walk at its call site.
    {
      code: 'function specifiersOf(file) {\n  return readFileSync(file, "utf8").match(/from "(.+)"/);\n}\nfor (const demo of readdirSync(dir).filter((name) => name.endsWith(".tsx"))) specifiersOf(demo);',
      errors: [{ messageId: "source" }],
    },
  ],
});
