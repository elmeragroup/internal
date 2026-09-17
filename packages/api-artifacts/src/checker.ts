import path from "node:path";
import type { SourceFile } from "typescript/unstable/ast";
import { isExpressionStatement, isStringLiteral } from "typescript/unstable/ast/is";
import { API, NodeBuilderFlags, SignatureKind, SymbolFlags } from "typescript/unstable/sync";
import type { Checker, Program, Project, Symbol as TsSymbol, Type } from "typescript/unstable/sync";

import type { ComponentSourceRequest, ComponentSourceResult } from "@elmeragroup/api-extractor";

import type { ProblemLog } from "./errors.ts";
import type { ApiPart, ApiProp, RscStatus } from "./model.ts";
import { compareUtf16CodeUnits } from "./ordering.ts";

export type LibraryProject = {
  projectRoot: string;
  project: Project;
  checker: Checker;
  program: Program;
  close: () => void;
};

/** Opens the configured project. Callers must close the result. */
export function openLibraryProject(tsconfigPath: string, projectRoot: string): LibraryProject {
  const api = new API({ cwd: projectRoot });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [tsconfigPath] });
    const project = snapshot.getProject(tsconfigPath);
    if (project === undefined) throw new Error(`Could not open the project at ${tsconfigPath}`);
    return {
      projectRoot,
      project,
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

/** Package name a forwarded prop comes from, e.g. `@base-ui/react` or `react`. */
function declaringPackage(declarationPath: string): string | null {
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
 * Classifies a prop from facts supplied by either checker.  Recipe axes are
 * checker-synthesized in the current model and are declared in `*-variants`
 * sources by the Effect model; neither case needs the consumer-facing JSDoc
 * policy applied to ordinary declared props.
 */
export function propOrigin(declarationPaths: readonly string[], synthesized: boolean): ApiProp["origin"] {
  return synthesized || declarationPaths.some(isRecipeAxisDeclaration) ? "recipe-axis" : "declared";
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
  problems: ProblemLog
): PartSource | null {
  if (result.status === "unresolved") {
    problems.add(`${partName}: could not recover the authored implementation (${result.reason})`);
    return null;
  }
  const sourceFile = context.program.getSourceFile(result.filePath);
  if (sourceFile === undefined) {
    problems.add(`${partName}: could not load the authored implementation file (${result.filePath})`);
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
  // TypeScript 7 exposes the shared NoTruncation printer bit through NodeBuilderFlags.
  const printed = checker.typeToString(type, undefined, NodeBuilderFlags.NoTruncation);
  return printed === "" ? null : printed;
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
  const declarationPaths = symbol.declarations.map((declaration) => declaration.path);
  return (
    propOrigin(declarationPaths, symbol.declarations.length === 0) !== "recipe-axis" &&
    !isOwnProp(context, symbol)
  );
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
      const packageName = declaringPackage(declaration.path);
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
  problems: ProblemLog
): readonly PartRequest[] {
  const { checker, program } = context;
  const sourceFile = program.getSourceFile(request.entryFile);
  if (sourceFile === undefined) {
    problems.add(`${request.entryFile}: entry module is not part of the library program`);
    return [];
  }
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol === undefined) {
    problems.add(`${request.entryFile}: entry module has no module symbol`);
    return [];
  }
  const moduleExports = checker.getExportsOfModule(moduleSymbol);
  const parts: PartRequest[] = [];
  for (const exportName of request.exportNames) {
    const rootSymbol = moduleExports.find((exported) => exported.name === exportName);
    if (rootSymbol === undefined) {
      problems.add(`${request.entryFile}: does not export "${exportName}"`);
      continue;
    }
    const rootType = checker.getTypeOfSymbol(rootSymbol);
    if (rootType === undefined || rootType.isErrorType()) {
      problems.add(`${exportName}: exported value has an unresolvable type`);
      continue;
    }
    if (hasCallSignatures(checker, rootType)) {
      parts.push({ name: exportName, exportName, type: rootType });
      continue;
    }
    const start = parts.length;
    for (const member of checker.getPropertiesOfType(rootType)) {
      const memberType = checker.getTypeOfSymbol(member);
      if (memberType === undefined || !hasCallSignatures(checker, memberType)) continue;
      parts.push({
        name: `${exportName}.${member.name}`,
        exportName,
        memberName: member.name,
        type: memberType,
      });
    }
    if (parts.length === start) {
      problems.add(`${exportName}: no renderable parts were found on the exported namespace`);
    }
  }
  return parts;
}

/** Checker-owned facts for one public prop, including props omitted as forwarded. */
export type CurrentPartPropFact = {
  readonly type: string | null;
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
  return {
    type: printType(context.checker, context.checker.getTypeOfSymbol(property)),
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
  | { readonly kind: "resolved"; readonly props: ReadonlyMap<string, TsSymbol> };

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
  if (declared === undefined || declared.isErrorType()) return { kind: "one", props: { kind: "unresolved" } };
  const props = new Map<string, TsSymbol>();
  for (const property of checker.getPropertiesOfType(declared)) {
    props.set(property.name, property);
  }
  return { kind: "one", props: { kind: "resolved", props } };
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
  problems: ProblemLog
): ApiProp[] {
  const { checker } = context;
  const rows: ApiProp[] = [];
  for (const property of props.values()) {
    const declarationPaths = property.declarations.map((declaration) => declaration.path);
    const isRecipeAxis = propOrigin(declarationPaths, property.declarations.length === 0) === "recipe-axis";
    if (isForwardedProp(context, property)) continue;
    const printed = printType(checker, checker.getTypeOfSymbol(property));
    if (printed === null) {
      problems.add(
        `${request.name}.${property.name}: type is unresolvable — the docs build cannot print it (${source.sourcePath})`
      );
      continue;
    }
    const description = dedupeDocumentation(checker.getDocumentationCommentOfSymbol(property));
    if (description === "" && !isRecipeAxis) {
      problems.add(
        `${request.name}.${property.name}: public prop has no JSDoc description (${source.sourcePath})`
      );
      continue;
    }
    rows.push({
      name: property.name,
      origin: isRecipeAxis ? "recipe-axis" : "declared",
      type: printed,
      shortType: shortTypeOf(property.name, printed),
      defaultValue: source.defaults.get(property.name) ?? null,
      description,
      required: !isOptional(property),
    });
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
  problems: ProblemLog
): ApiPart | null {
  if (contract.kind !== "one") {
    problems.add(
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
      problems.add(`${request.name}: props type is unresolvable`);
      return null;
    case "resolved":
      return {
        name: request.name,
        rsc: source.rsc,
        sourcePath: source.sourcePath,
        props: describeProps(context, request, source, contract.props.props, problems),
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
  problems: ProblemLog
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
