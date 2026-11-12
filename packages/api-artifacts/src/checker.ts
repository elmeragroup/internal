import path from "node:path";
import type { SourceFile } from "tsrs/ast";
import { isExpressionStatement, isStringLiteral } from "tsrs/ast/is";
import { API, SignatureKind, SymbolFlags, TypeFlags, TypeFormatFlags } from "tsrs/sync";
import type { Checker, Program, Project, Symbol as TsSymbol, Type } from "tsrs/sync";

import { compilerStartError, projectMissingError, projectOpenError } from "@elmeragroup/api-extractor";
import type { ComponentSourceRequest, ComponentSourceResult } from "@elmeragroup/api-extractor";

import type { ApiPart, ApiProp, RscStatus } from "./model.ts";
import { compareUtf16CodeUnits } from "./ordering.ts";

export type LibraryProject = {
  projectRoot: string;
  checker: Checker;
  program: Program;
  close: () => void;
};

/**
 * Opens the configured project. Callers must close the result.
 *
 * @throws The extractor's typed `BackendError` when the compiler cannot start, such as on a
 *   platform without a tsrs binary, or cannot open the project.
 */
export function openLibraryProject(tsconfigPath: string, projectRoot: string): LibraryProject {
  let api: API;
  try {
    api = new API({ cwd: projectRoot });
  } catch (cause) {
    throw compilerStartError(tsconfigPath, cause);
  }
  try {
    let project: Project | undefined;
    try {
      project = api.createSnapshot({ openProjects: [tsconfigPath] }).getConfiguredProject(tsconfigPath);
    } catch (cause) {
      throw projectOpenError(tsconfigPath, cause);
    }
    if (project === undefined) throw projectMissingError(tsconfigPath);
    return {
      projectRoot,
      checker: project.checker,
      program: project.program,
      close: () => api.close(),
    };
  } catch (error) {
    api.close();
    throw error;
  }
}

/**
 * A `"use client"` directive only counts as one when it leads the module, so a stray
 * string expression further down never flips the classification.
 */
export function readRscStatus(sourceFile: SourceFile): RscStatus {
  for (const statement of sourceFile.statements) {
    if (!isExpressionStatement(statement) || !isStringLiteral(statement.expression)) {
      return "server";
    }
    const authored = statement.expression.getText(sourceFile);
    if (authored === '"use client"' || authored === "'use client'") {
      return "client";
    }
  }
  return "server";
}

/**
 * Package name a forwarded prop comes from, e.g. `@base-ui/react` or `react`. TypeScript's default
 * library is `typescript` wherever the compiler installed it: tsrs ships it inside a per-platform
 * package such as `@tsrs/linux-x64-gnu`, and an artifact must not depend on the machine that
 * generated it.
 */
function declaringPackage(context: LibraryProject, declarationPath: string): string | null {
  if (context.program.getSourceFileMetadata(declarationPath)?.isDefaultLibrary === true) {
    return "typescript";
  }
  const marker = "/node_modules/";
  const last = declarationPath.lastIndexOf(marker);
  if (last === -1) {
    return null;
  }
  const rest = declarationPath.slice(last + marker.length);
  const segments = rest.split("/");
  const first = segments[0];
  if (first === undefined) {
    return null;
  }
  if (first.startsWith("@")) {
    const second = segments[1];
    return second === undefined ? first : `${first}/${second}`;
  }
  return first;
}

function isOwnProp(context: LibraryProject, symbol: TsSymbol): boolean {
  return symbol.declarations.some((declaration) => {
    const relative = path
      .relative(context.projectRoot.toLowerCase(), declaration.path.toLowerCase())
      .replaceAll("\\", "/");
    return (
      relative !== ".." &&
      !relative.startsWith("../") &&
      !path.isAbsolute(relative) &&
      !relative.split("/").includes("node_modules")
    );
  });
}

function isOptional(symbol: TsSymbol): boolean {
  return (symbol.flags & SymbolFlags.Optional) !== 0;
}

export type PartSource = {
  /** Repo-relative path of the file that declares the part. */
  sourcePath: string;
  rsc: RscStatus;
  /** Forwarded values accept only dependency-declared props and are never enriched. */
  readonly origin: "resolved" | "forwarded";
  /** Destructuring defaults, keyed by prop name. */
  defaults: ReadonlyMap<string, string>;
};

function isRecipeAxisDeclaration(declarationPath: string): boolean {
  const normalized = declarationPath.replaceAll("\\", "/");
  const file = normalized.slice(normalized.lastIndexOf("/") + 1);
  return file.endsWith("-variants.ts") || file.endsWith("-variants.tsx");
}

/**
 * Recipe axes are either checker-synthesized (no declaration) or declared in
 * `*-variants` sources; neither case needs the consumer-facing JSDoc policy
 * applied to ordinary declared props.
 */
function isRecipeAxisProp(symbol: TsSymbol): boolean {
  return (
    symbol.declarations.length === 0 ||
    symbol.declarations.some((declaration) => isRecipeAxisDeclaration(declaration.path))
  );
}

/**
 * Turns one source-inspection result into artifact source metadata. Unresolved
 * implementations become an actionable problem instead of React declaration paths.
 * A forwarded dependency value reads its metadata from the authored module that
 * forwards it: that module's directive decides `rsc`, and it has no defaults.
 */
function partSourceFromInspection(
  context: LibraryProject,
  partName: string,
  result: ComponentSourceResult,
  problems: string[]
): PartSource | null {
  if (result.status === "unresolved") {
    problems.push(`${partName}: could not recover the authored implementation (${result.reason})`);
    return null;
  }
  const sourceFile = context.program.getSourceFile(result.filePath);
  if (sourceFile === undefined) {
    problems.push(`${partName}: could not load the authored implementation file (${result.filePath})`);
    return null;
  }
  return {
    sourcePath: path.relative(context.projectRoot, sourceFile.fileName).replaceAll("\\", "/"),
    rsc: readRscStatus(sourceFile),
    origin: result.status === "forwarded" ? "forwarded" : "resolved",
    defaults: new Map(
      result.status === "resolved" ? result.defaults.map((entry) => [entry.name, entry.initializerText]) : []
    ),
  };
}

/**
 * A symbol declared in several union branches reports each branch's JSDoc in turn.
 * Identical paragraphs are the same sentence repeated, not two facts.
 */
export function dedupeDocumentation(documentation: string | undefined): string {
  if (documentation === undefined) {
    return "";
  }
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const paragraph of documentation.split(/\n{2,}|\n/)) {
    const trimmed = paragraph.trim();
    if (trimmed === "" || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    kept.push(trimmed);
  }
  return kept.join(" ");
}

function printType(checker: Checker, type: Type | undefined): string | null {
  if (type === undefined || type.isErrorType()) {
    return null;
  }
  const printed = checker.typeToString(type, undefined, TypeFormatFlags.NoTruncation);
  return printed === "" ? null : printed;
}

/**
 * The string literals a type admits, without `undefined` and `null`, deduplicated, in checker
 * order. TypeScript 7 orders string literals by value. `"any"` when the type admits a value that
 * is not a string literal, such as `string` or `boolean`.
 */
function literalMembersOf(type: Type): readonly string[] | "any" {
  const members = type.isUnionType() ? type.getTypes() : [type];
  const values: string[] = [];
  for (const member of members) {
    if ((member.flags & (TypeFlags.Undefined | TypeFlags.Null)) !== 0) continue;
    if (!member.isStringLiteralType()) return "any";
    if (!values.includes(member.value)) values.push(member.value);
  }
  return values;
}

/**
 * The string literals a prop accepts, when its type is a finite union of two or more of them.
 * `null` for any other type. The checker expands aliases such as `ButtonSize` into one union,
 * so this reads the resolved type, where `printType` keeps the alias names.
 */
function literalValuesOf(type: Type): readonly string[] | null {
  const values = literalMembersOf(type);
  return values !== "any" && values.length >= 2 ? values : null;
}

/** One arm of a props union: the values it admits for each prop, and the props it requires. */
type PropsArm = {
  readonly values: ReadonlyMap<string, readonly string[] | "any">;
  readonly required: ReadonlySet<string>;
};

/** The arms of a props type that is a union, such as `LabelButtonProps | IconButtonProps`. */
function propsArmsOf(checker: Checker, type: Type): readonly PropsArm[] {
  if (!type.isUnionType()) return [];
  return type.getTypes().map((arm) => {
    const values = new Map<string, readonly string[] | "any">();
    const required = new Set<string>();
    for (const property of checker.getPropertiesOfType(arm)) {
      values.set(property.name, literalMembersOf(checker.getTypeOfSymbol(property)));
      if (!isOptional(property)) required.add(property.name);
    }
    return { values, required };
  });
}

/** Whether every name of `smaller` is in `larger`. */
function isSubset(smaller: readonly string[], larger: readonly string[]): boolean {
  return smaller.every((name) => larger.includes(name));
}

/**
 * The props each value of `prop` needs beside it, read from the props union's arms. Each arm
 * that admits a value gives one alternative, the props it requires less the props every arm
 * requires. A value passes with any one alternative, so only the minimal ones are kept, each
 * once. A value that some arm admits with nothing more is left out, and so is the field when no
 * value needs anything. Button's `size="icon"` needs `[["aria-label"]]`, and a prop that one arm
 * names through `aria-label` and another through `aria-labelledby` needs
 * `[["aria-label"], ["aria-labelledby"]]`.
 */
function valueRequirementsOf(
  arms: readonly PropsArm[],
  prop: string,
  values: readonly string[]
): Readonly<Record<string, readonly (readonly string[])[]>> | null {
  const [first, ...rest] = arms;
  if (first === undefined) return null;
  const everywhere = [...first.required].filter((name) => rest.every((arm) => arm.required.has(name)));
  const requirements: Record<string, readonly (readonly string[])[]> = {};
  for (const value of values) {
    const alternatives: (readonly string[])[] = [];
    for (const arm of arms) {
      // An arm without the prop admits only its absence, so it never admits a value.
      const admitted = arm.values.get(prop);
      if (admitted === undefined || (admitted !== "any" && !admitted.includes(value))) continue;
      alternatives.push(
        [...arm.required]
          .filter((name) => name !== prop && !everywhere.includes(name))
          .sort(compareUtf16CodeUnits)
      );
    }
    if (alternatives.length === 0 || alternatives.some((needs) => needs.length === 0)) continue;
    // A set that holds another set is never the cheaper way to pass, so it goes, as do repeats.
    const minimal = alternatives.filter(
      (needs, index) =>
        !alternatives.some(
          (other, at) => at !== index && isSubset(other, needs) && (other.length < needs.length || at < index)
        )
    );
    requirements[value] = minimal.sort(
      (left, right) =>
        left.length - right.length || compareUtf16CodeUnits(left.join("\u0000"), right.join("\u0000"))
    );
  }
  return Object.keys(requirements).length === 0 ? null : requirements;
}

/**
 * The one-line type a closed reference row shows, or `null` when the printed type is
 * short enough to show in full.
 *
 * A plain-string heuristic on purpose: it decides what a *collapsed* row displays, and
 * the expanded panel always carries the real signature, so being approximate costs
 * nothing while parsing the printed type would cost a second type model.
 *
 * `on`/`get` must be followed by a capital to count as the handler/accessor convention —
 * a prop literally named `open` or `gettable` is not a function.
 */
export function shortTypeOf(propName: string, printedType: string): string | null {
  if (/^(?:on|get)[A-Z]/.test(propName) || printedType.includes("=>")) {
    return "function";
  }
  const unionBars = printedType.split("|").length - 1;
  if (unionBars >= 2 || printedType.length >= 30) {
    return "Union";
  }
  return null;
}

export type PartRequest = ComponentSourceRequest & {
  /** Display name, e.g. `Dialog.Content`. */
  name: string;
  type: Type;
};

/**
 * Whether a type exposes at least one call signature, i.e. whether it can be a
 * component or one of a namespace's component members. The walk asks only this so
 * it never resolves a props type before the part itself is described.
 */
function hasCallSignatures(checker: Checker, type: Type): boolean {
  return checker.getSignaturesOfType(type, SignatureKind.Call).length > 0;
}

function isForwardedProp(context: LibraryProject, symbol: TsSymbol): boolean {
  return !isRecipeAxisProp(symbol) && !isOwnProp(context, symbol);
}

/** Forwarded-prop summary for one checker-backed part: omitted count and declaring packages. */
export type PartForwarded = {
  readonly count: number;
  readonly from: readonly string[];
};

const emptyForwarded: PartForwarded = { count: 0, from: [] };

/** A forwarded value's own declaring package joins the packages its forwarded props come from. */
function withForwardedValue(forwarded: PartForwarded, result: ComponentSourceResult): PartForwarded {
  if (result.status !== "forwarded" || forwarded.from.includes(result.packageName)) return forwarded;
  const from = [...forwarded.from, result.packageName].sort(compareUtf16CodeUnits);
  return { count: forwarded.count, from };
}

/**
 * Counts props the part accepts that are neither library-declared nor recipe
 * axes — the same omitted set the published table drops.
 */
function forwardedOfProps(context: LibraryProject, properties: Iterable<TsSymbol>): PartForwarded {
  const from = new Set<string>();
  let count = 0;
  for (const property of properties) {
    if (!isForwardedProp(context, property)) continue;
    count += 1;
    for (const declaration of property.declarations) {
      const packageName = declaringPackage(context, declaration.path);
      if (packageName !== null) from.add(packageName);
    }
  }
  return { count, from: [...from].sort(compareUtf16CodeUnits) };
}

export type ComponentApiRequest = {
  /** Absolute path of the public entry module, e.g. `/project/src/button.ts`. */
  entryFile: string;
  /**
   * Component exports to inspect, in display order. Only named exports are inspected.
   */
  exportNames: readonly string[];
};

/**
 * Resolves the checker-backed part requests for one public component.  This is
 * the *only* walk of a component's entry: generation calls it once and
 * every downstream fact is read from the parts it returns.
 */
export function componentPartRequests(
  context: LibraryProject,
  request: ComponentApiRequest,
  problems: string[]
): readonly PartRequest[] {
  const { checker, program } = context;
  const sourceFile = program.getSourceFile(request.entryFile);
  if (sourceFile === undefined) {
    problems.push(`${request.entryFile}: entry module is not part of the library program`);
    return [];
  }
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol === undefined) {
    problems.push(`${request.entryFile}: entry module has no module symbol`);
    return [];
  }
  const moduleExports = checker.getExportsOfModule(moduleSymbol);
  const parts: PartRequest[] = [];
  for (const exportName of request.exportNames) {
    const rootSymbol = moduleExports.find((exported) => exported.name === exportName);
    if (rootSymbol === undefined) {
      problems.push(`${request.entryFile}: does not export "${exportName}"`);
      continue;
    }
    const rootType = checker.getTypeOfSymbol(rootSymbol);
    if (rootType.isErrorType()) {
      problems.push(`${exportName}: exported value has an unresolvable type`);
      continue;
    }
    if (hasCallSignatures(checker, rootType)) {
      parts.push({ name: exportName, exportName, type: rootType });
      continue;
    }
    const start = parts.length;
    for (const member of checker.getPropertiesOfType(rootType)) {
      const memberType = checker.getTypeOfSymbol(member);
      if (!hasCallSignatures(checker, memberType)) continue;
      parts.push({
        name: `${exportName}.${member.name}`,
        exportName,
        memberName: member.name,
        type: memberType,
      });
    }
    if (parts.length === start) {
      problems.push(`${exportName}: no renderable parts were found on the exported namespace`);
    }
  }
  return parts;
}

/** Checker-owned facts for one public prop, including props omitted as forwarded. */
export type CurrentPartPropFact = {
  readonly type: string | null;
  /** The prop's string literal options, as `literalValuesOf` reads them. */
  readonly values: readonly string[] | null;
  readonly required: boolean;
};

/**
 * Prints one accepted prop's checker facts.
 *
 * Printing a type is the single most expensive checker call in the pass, so it is
 * done per prop a consumer actually asks about — the dependency-enrichment merge
 * asks for the handful of Base UI props it selects, not for all ~300 React and DOM
 * props every part forwards.
 */
export function readPartPropFact(
  context: LibraryProject,
  part: LibraryPartApi,
  propName: string
): CurrentPartPropFact | undefined {
  const property = part.props.get(propName);
  if (property === undefined) {
    return undefined;
  }
  const type = context.checker.getTypeOfSymbol(property);
  return {
    type: printType(context.checker, type),
    values: literalValuesOf(type),
    required: !isOptional(property),
  };
}

/**
 * Every checker fact one part of a component yields, read from a single traversal:
 * the published table row set, the implementation source, the forwarded-prop
 * summary, and the accepted prop symbols the enrichment merge look props up in.
 */
export type LibraryPartApi = {
  /** Display name, e.g. `Dialog.Content`. */
  readonly name: string;
  readonly source: PartSource | null;
  readonly forwarded: PartForwarded;
  /** Every prop the part accepts, in checker order, forwarded ones included. */
  readonly props: ReadonlyMap<string, TsSymbol>;
  /** The published rows, or `null` when the part could not be described. */
  readonly part: ApiPart | null;
};

/** One component's API model: the published parts plus the facts behind them. */
export type ComponentApi = {
  readonly slug: string;
  readonly exportNames: readonly string[];
  /** The parts the docs publish, in walk order. */
  readonly parts: readonly ApiPart[];
  /** One entry per traversed part, described or not. */
  readonly partApis: readonly LibraryPartApi[];
};

/**
 * What a single call signature's first parameter yields: `absent` when there is
 * none, `unresolved` when its type is missing or an error type, and `resolved`
 * with the accepted prop symbols.
 */
type PropsParameter =
  | { readonly kind: "absent" }
  | { readonly kind: "unresolved" }
  | {
      readonly kind: "resolved";
      readonly props: ReadonlyMap<string, TsSymbol>;
      /** The arms of the props type when it is a union; empty otherwise. */
      readonly arms: readonly PropsArm[];
    };

/**
 * What one part's call signatures yield for its published props contract. `none`
 * and `many` are the signature problems that fail generation; `one` carries the
 * single signature's props parameter. No state is built for a question another
 * state answers.
 */
type PartContract =
  | { readonly kind: "none" }
  | { readonly kind: "many"; readonly count: number }
  | { readonly kind: "one"; readonly props: PropsParameter };

/** Resolves what a part's call signatures yield, reading its props type at most once. */
function partContractOf(checker: Checker, type: Type): PartContract {
  const signatures = checker.getSignaturesOfType(type, SignatureKind.Call);
  const first = signatures[0];
  if (first === undefined) return { kind: "none" };
  if (signatures.length > 1) return { kind: "many", count: signatures.length };
  const parameter = first.getParameters()[0];
  if (parameter === undefined) return { kind: "one", props: { kind: "absent" } };
  const declared = checker.getTypeOfSymbol(parameter);
  if (declared.isErrorType()) return { kind: "one", props: { kind: "unresolved" } };
  const props = new Map<string, TsSymbol>();
  for (const property of checker.getPropertiesOfType(declared)) {
    props.set(property.name, property);
  }
  return { kind: "one", props: { kind: "resolved", props, arms: propsArmsOf(checker, declared) } };
}

/**
 * Builds the published prop rows for a resolved props parameter. A prop with no
 * declaration at all is synthesised by `VariantProps` over a library `tv` recipe:
 * there is no declaration site to hang JSDoc on, so its printed union is the
 * documentation and the JSDoc gate does not apply.
 */
function describeProps(
  context: LibraryProject,
  request: PartRequest,
  source: PartSource,
  props: ReadonlyMap<string, TsSymbol>,
  arms: readonly PropsArm[],
  problems: string[]
): ApiProp[] {
  const { checker } = context;
  const rows: ApiProp[] = [];
  for (const property of props.values()) {
    const isRecipeAxis = isRecipeAxisProp(property);
    if (!isRecipeAxis && !isOwnProp(context, property)) continue;
    const type = checker.getTypeOfSymbol(property);
    const printed = printType(checker, type);
    if (printed === null) {
      problems.push(
        `${request.name}.${property.name}: type is unresolvable — the docs build cannot print it (${source.sourcePath})`
      );
      continue;
    }
    const description = dedupeDocumentation(checker.getDocumentationCommentOfSymbol(property));
    if (description === "" && !isRecipeAxis) {
      problems.push(
        `${request.name}.${property.name}: public prop has no JSDoc description (${source.sourcePath})`
      );
      continue;
    }
    const row: ApiProp = {
      name: property.name,
      origin: isRecipeAxis ? "recipe-axis" : "declared",
      type: printed,
      shortType: shortTypeOf(property.name, printed),
      defaultValue: source.defaults.get(property.name) ?? null,
      description,
      required: !isOptional(property),
    };
    const values = literalValuesOf(type);
    if (values !== null) {
      row.values = values;
      const requires = valueRequirementsOf(arms, property.name, values);
      if (requires !== null) row.requires = requires;
    }
    rows.push(row);
  }
  rows.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
  return rows;
}

function describePart(
  context: LibraryProject,
  request: PartRequest,
  contract: PartContract,
  source: PartSource | null,
  forwarded: PartForwarded,
  problems: string[]
): ApiPart | null {
  if (contract.kind !== "one") {
    problems.push(
      contract.kind === "none"
        ? `${request.name}: no call signature — it does not look like a component`
        : `${request.name}: ${String(contract.count)} call signatures — API artifacts describe one public props contract; keep one public overload`
    );
    return null;
  }
  if (source === null) {
    return null;
  }
  switch (contract.props.kind) {
    case "absent":
      return {
        name: request.name,
        rsc: source.rsc,
        sourcePath: source.sourcePath,
        props: [],
        forwardedFrom: forwarded.from,
        forwardedCount: 0,
      };
    case "unresolved":
      problems.push(`${request.name}: props type is unresolvable`);
      return null;
    case "resolved":
      return {
        name: request.name,
        rsc: source.rsc,
        sourcePath: source.sourcePath,
        props: describeProps(context, request, source, contract.props.props, contract.props.arms, problems),
        forwardedFrom: forwarded.from,
        forwardedCount: forwarded.count,
      };
  }
}

/** Reads every fact one part yields, resolving its props type exactly once. */
export function extractPart(
  context: LibraryProject,
  request: PartRequest,
  sourceResult: ComponentSourceResult,
  problems: string[]
): LibraryPartApi {
  const source = partSourceFromInspection(context, request.name, sourceResult, problems);
  const contract = partContractOf(context.checker, request.type);
  const props =
    contract.kind === "one" && contract.props.kind === "resolved"
      ? contract.props.props
      : new Map<string, TsSymbol>();
  const forwarded = withForwardedValue(
    props.size === 0 ? emptyForwarded : forwardedOfProps(context, props.values()),
    sourceResult
  );
  return {
    name: request.name,
    source,
    forwarded,
    props,
    part: describePart(context, request, contract, source, forwarded, problems),
  };
}
