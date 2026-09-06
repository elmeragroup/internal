import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type BoundaryViolation = {
  readonly path: string;
  readonly reason: string;
};

export const sourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

/**
 * These directories are either dependency/build state or data used by tests.
 * Fixture programs and mutation strings are deliberately not package
 * implementation imports and must not become boundary violations.
 */
const excludedDirectoryNames = new Set([
  ".git",
  ".cache",
  ".turbo",
  "cache",
  "dist",
  "generated",
  "node_modules",
  "reference",
  "references",
  "fixtures",
  "__fixtures__",
  "__snapshots__",
]);

/** Remove comments without deleting string/template literals used by imports. */
export function stripComments(source: string): string {
  let output = "";
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (lineComment) {
      if (current === "\n") {
        lineComment = false;
        output += current;
      } else {
        output += " ";
      }
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        output += "  ";
        index += 1;
      } else {
        output += current === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (quote !== undefined) {
      output += current;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === quote) {
        quote = undefined;
      }
      continue;
    }
    if (current === "/" && next === "/") {
      lineComment = true;
      output += "  ";
      index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      blockComment = true;
      output += "  ";
      index += 1;
      continue;
    }
    if (current === "'" || current === '"' || current === "`") quote = current;
    output += current;
  }
  return output;
}

/**
 * Detects compiler imports by scanning all string/template literals after
 * comments have been removed. This intentionally covers static, type-only,
 * side-effect, dynamic/template, and require forms with one lexical rule.
 */
export function scanCompilerImports(source: string): readonly string[] {
  const cleaned = stripComments(source);
  const matches: string[] = [];
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  let literalStart = -1;
  for (let index = 0; index < cleaned.length; index += 1) {
    const current = cleaned[index] ?? "";
    if (quote === undefined) {
      if (current === "'" || current === '"' || current === "`") {
        quote = current;
        literalStart = index + 1;
        escaped = false;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (current === "\\") {
      escaped = true;
      continue;
    }
    if (current !== quote) continue;
    const literal = cleaned.slice(literalStart, index);
    const before = cleaned.slice(0, literalStart - 1).trimEnd();
    if (/(?:\bfrom|\bimport|\brequire(?:\.resolve)?)\s*(?:\(\s*)?$/u.test(before)) {
      const prefix = /^typescript(?:\/|$)/u.exec(literal)?.[0];
      if (prefix !== undefined) matches.push(prefix);
    }
    quote = undefined;
    literalStart = -1;
  }
  return [...new Set(matches)];
}

/** Return every literal import/export edge, including import types. */
export function scanModuleSpecifiers(source: string): readonly string[] {
  const cleaned = stripComments(source);
  const matches: string[] = [];
  const pattern =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire(?:\.resolve)?\s*\(\s*)["'`]([^"'`$]*?)["'`]/gu;
  for (const match of cleaned.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier !== undefined && !specifier.includes("${")) matches.push(specifier);
  }
  return [...new Set(matches)];
}

/**
 * The slice of `before` that belongs to the import or export statement whose
 * specifier is being classified.
 *
 * Anchoring matters: testing the whole prefix would let ONE earlier
 * `import type` mark every later import in the file type-only, which hides a
 * real value import (nearly every `src/parse/**` file opens with an
 * `import type`). The statement starts after the last terminator, and at the
 * last `import`/`export` keyword within it — a bare `require(...)` or dynamic
 * `import(...)` therefore never inherits a preceding statement's `type`.
 */
function currentStatement(before: string): string {
  const afterTerminator = before.slice(before.lastIndexOf(";") + 1);
  let start = -1;
  for (const match of afterTerminator.matchAll(/(?:^|[\s{(=,])((?:import|export)\b)/gu)) {
    const keyword = match[1];
    if (keyword !== undefined) start = match.index + match[0].length - keyword.length;
  }
  return (start === -1 ? afterTerminator : afterTerminator.slice(start)).trimStart();
}

function isTypeOnlySpecifierContext(beforeSpecifier: string): boolean {
  const before = currentStatement(beforeSpecifier);
  if (/^(?:import|export)\s+type\b/u.test(before)) return true;
  const inline = /\{([^}]*)\}\s*$/u.exec(before)?.[1];
  if (inline === undefined) return false;
  const bindings = inline
    .split(",")
    .map((binding) => binding.trim())
    .filter((binding) => binding.length > 0);
  return bindings.length > 0 && bindings.every((binding) => /^type\s+/u.test(binding));
}

/** Return value import/export specifiers, skipping `import type` / `export type`. */
export function scanValueModuleSpecifiers(source: string): readonly string[] {
  const cleaned = stripComments(source);
  const matches: string[] = [];
  const pattern =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire(?:\.resolve)?\s*\(\s*)["'`]([^"'`$]*?)["'`]/gu;
  for (const match of cleaned.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier === undefined || specifier.includes("${")) continue;
    const before = cleaned.slice(0, match.index).trimEnd();
    if (isTypeOnlySpecifierContext(before)) continue;
    matches.push(specifier);
  }
  return [...new Set(matches)];
}

function isEffectSpecifier(specifier: string): boolean {
  return specifier === "effect" || specifier.startsWith("effect/");
}

function sourceImportCandidates(filePath: string, specifier: string): readonly string[] {
  const base = resolve(dirname(filePath), specifier);
  const scriptExtension = /\.(?:[cm]?[jt]sx?)$/u.exec(base)?.[0];
  const withoutScriptExtension =
    scriptExtension === undefined ? base : base.slice(0, -scriptExtension.length);
  return [
    base,
    ...sourceExtensions.map((extension) => `${withoutScriptExtension}${extension}`),
    ...sourceExtensions.map((extension) => join(withoutScriptExtension, `index${extension}`)),
  ];
}

function resolveSourceImport(filePath: string, specifier: string): string | undefined {
  return sourceImportCandidates(filePath, specifier).find((candidate) => existsSync(candidate));
}

/** Walk value-import graphs from `entries` and report every Effect module they reach. */
export function effectImportViolations(entries: readonly string[]): readonly BoundaryViolation[] {
  const queue = [...entries];
  const seen = new Set<string>();
  const violations: BoundaryViolation[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current) || !existsSync(current)) continue;
    seen.add(current);
    const source = readFileSync(current, "utf8");
    for (const specifier of scanValueModuleSpecifiers(source)) {
      if (isEffectSpecifier(specifier)) {
        violations.push({ path: current, reason: `Effect import ${specifier}` });
        continue;
      }
      if (!specifier.startsWith(".")) continue;
      const target = resolveSourceImport(current, specifier);
      if (target !== undefined) queue.push(target);
    }
  }
  return violations;
}

function files(directory: string, extensions: readonly string[]): readonly string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && excludedDirectoryNames.has(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? files(path, extensions)
      : extensions.some((extension) => path.endsWith(extension))
        ? [path]
        : [];
  });
}

export function sourceFiles(directory: string): readonly string[] {
  return files(directory, sourceExtensions);
}

/**
 * Return package-authored executable sources and root configuration modules.
 * The scan intentionally has explicit roots so dependency trees, generated
 * output, and fixture data cannot be mistaken for implementation code.
 */
export function packageSourceFiles(packageDirectory: string): readonly string[] {
  const roots = ["src", "scripts", "test"].flatMap((root) => sourceFiles(join(packageDirectory, root)));
  const rootFiles = readdirSync(packageDirectory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isFile() || !sourceExtensions.some((extension) => entry.name.endsWith(extension))) {
      return [];
    }
    return [join(packageDirectory, entry.name)];
  });
  return [...new Set([...roots, ...rootFiles])].sort();
}

export function sourceBoundaryViolations(path: string, source: string): readonly BoundaryViolation[] {
  const compilerImports = scanCompilerImports(source).map((specifier) => ({
    path,
    reason: `compiler import ${specifier}`,
  }));
  const sourceIdentity = resolve(path).replace(/\.[cm]?[jt]sx?$/u, "");
  const parseDirectory = dirname(sourceIdentity);
  const leafIdentity = sourceIdentity.slice(parseDirectory.length + 1);
  const importsTopLevelResolver =
    parseDirectory.replaceAll("\\", "/").endsWith("/src/parse") &&
    (leafIdentity === "object-resolver" || leafIdentity === "fallback") &&
    scanModuleSpecifiers(source).some((specifier) => {
      if (!specifier.startsWith(".")) return false;
      const targetIdentity = resolve(dirname(path), specifier).replace(/\.[cm]?[jt]sx?$/u, "");
      return targetIdentity === join(parseDirectory, "resolver");
    });
  return importsTopLevelResolver
    ? [...compilerImports, { path, reason: "parse leaf imports top-level resolver" }]
    : compilerImports;
}

function declarationCandidates(filePath: string, specifier: string): readonly string[] {
  const base = resolve(dirname(filePath), specifier);
  const scriptExtension = /\.(?:[cm]?[jt]sx?)$/u.exec(base)?.[0];
  const declarationExtension =
    scriptExtension === ".mts" || scriptExtension === ".mjs"
      ? ".d.mts"
      : scriptExtension === ".cts" || scriptExtension === ".cjs"
        ? ".d.cts"
        : ".d.ts";
  const withoutScriptExtension =
    scriptExtension === undefined ? base : base.slice(0, -scriptExtension.length);
  return [
    base,
    `${base}${declarationExtension}`,
    `${withoutScriptExtension}${declarationExtension}`,
    `${withoutScriptExtension}.d.ts`,
    `${withoutScriptExtension}.d.mts`,
    `${withoutScriptExtension}.d.cts`,
    join(withoutScriptExtension, "index.d.ts"),
    join(withoutScriptExtension, "index.d.mts"),
    join(withoutScriptExtension, "index.d.cts"),
  ];
}

function resolveDeclaration(filePath: string, specifier: string): string | undefined {
  return declarationCandidates(filePath, specifier).find(
    (candidate) => /\.d\.(?:ts|mts|cts)$/u.test(candidate) && existsSync(candidate)
  );
}

/** Traverse all declaration dependency edges reachable from the public index. */
export function publicDeclarationGraph(entry: string): readonly string[] {
  const queue = [resolve(entry)];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current) || !existsSync(current)) continue;
    seen.add(current);
    const source = readFileSync(current, "utf8");
    for (const specifier of scanModuleSpecifiers(source)) {
      const target = resolveDeclaration(current, specifier);
      if (target !== undefined && /\.d\.(?:ts|mts|cts)$/u.test(target)) queue.push(target);
    }
  }
  return [...seen];
}

function withoutImportDeclarations(source: string): string {
  return stripComments(source).replace(/^\s*import\b[\s\S]*?;\s*/gmu, "");
}

export function declarationBoundaryViolations(path: string, source: string): readonly BoundaryViolation[] {
  const violations = sourceBoundaryViolations(path, source);
  const moduleSpecifiers = scanModuleSpecifiers(source);
  const exportedBackend = moduleSpecifiers.filter((specifier) => specifier.includes("/backend/"));
  const publicText = withoutImportDeclarations(source);
  const compilerNames =
    publicText.match(
      /\bBackend(?!Error(?:_base)?\b)[A-Z][A-Za-z0-9_$]*\b|\bCompilerBackend[A-Z][A-Za-z0-9_$]*\b|\bCompilerBackend\b/gu
    ) ?? [];
  const scopeNames = /\bScope(?:\.Scope)?\b/u.test(publicText) ? ["Scope"] : [];
  return [
    ...violations,
    ...exportedBackend.map((specifier) => ({
      path,
      reason: `public declaration imports or re-exports ${specifier}`,
    })),
    ...[...new Set(compilerNames)].map((name) => ({ path, reason: `public declaration exposes ${name}` })),
    ...scopeNames.map((name) => ({ path, reason: `public declaration exposes ${name}` })),
  ];
}
