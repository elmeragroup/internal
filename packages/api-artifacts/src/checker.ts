import path from "node:path";
import type { SourceFile } from "typescript/unstable/ast";
import {
  isBindingElement,
  isExpressionStatement,
  isFunctionLikeDeclaration,
  isIdentifier,
  isObjectBindingPattern,
  isStringLiteral,
} from "typescript/unstable/ast/is";
import { API, NodeBuilderFlags, SignatureKind, SymbolFlags } from "typescript/unstable/sync";
import type {
  Checker,
  Program,
  Project,
  Signature,
  Symbol as TsSymbol,
  Type,
} from "typescript/unstable/sync";

import type { ProblemLog } from "./errors.ts";
import type { ApiPart, ApiProp, RscStatus } from "./model.ts";

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
 * Reads the implementation-side facts of a part: which file declares it (hence its RSC
 * status) and the defaults its props destructuring assigns.
 */
export function readPartSource(context: LibraryProject, signature: Signature): PartSource | null {
  const handle = signature.declaration;
  if (handle === undefined) {
    return null;
  }
  const node = handle.resolve(context.project);
  if (node === undefined) {
    return null;
  }
  const sourceFile = node.getSourceFile();
  const defaults = new Map<string, string>();
  if (isFunctionLikeDeclaration(node)) {
    const pattern = node.parameters[0]?.name;
    if (pattern !== undefined && isObjectBindingPattern(pattern)) {
      for (const element of pattern.elements) {
        if (!isBindingElement(element) || element.initializer === undefined) {
          continue;
        }
        const name = element.propertyName ?? element.name;
        if (name !== undefined && isIdentifier(name)) {
          defaults.set(name.text, element.initializer.getText().trim());
        }
      }
    }
  }
  return {
    sourcePath: path.relative(context.projectRoot, sourceFile.fileName).replaceAll("\\", "/"),
    rsc: readRscStatus(sourceFile),
    defaults,
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

export type PartRequest = {
  /** Display name, e.g. `Dialog.Content`. */
  name: string;
  type: Type;
};

function callSignature(checker: Checker, type: Type): Signature | null {
  const signatures = checker.getSignaturesOfType(type, SignatureKind.Call);
  return signatures[0] ?? null;
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
  return { count, from: [...from].sort((left, right) => left.localeCompare(right)) };
}

function addProblem(problems: ProblemLog | undefined, message: string): void {
  problems?.add(message);
}

export type ComponentApiRequest = {
  /** Absolute path of the public entry module, e.g. `/project/src/button.ts`. */
  entryFile: string;
  /**
   * Component exports to inspect, in display order. Only named exports are inspected.
   */
  exportNames: readonly string[];
};

/** One component of the docs inventory: its slug plus the entry surface to walk. */
export type LibraryApiRequest = ComponentApiRequest & { readonly slug: string };

/**
 * Resolves the checker-backed part requests for one public component.  This is
 * the *only* walk of a component's entry: `extractComponentApi` calls it once and
 * every downstream fact is read from the parts it returns.
 */
function componentPartRequests(
  context: LibraryProject,
  request: ComponentApiRequest,
  problems?: ProblemLog
): readonly PartRequest[] {
  const { checker, program } = context;
  const sourceFile = program.getSourceFile(request.entryFile);
  if (sourceFile === undefined) {
    addProblem(problems, `${request.entryFile}: entry module is not part of the library program`);
    return [];
  }
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol === undefined) {
    addProblem(problems, `${request.entryFile}: entry module has no module symbol`);
    return [];
  }
  const moduleExports = checker.getExportsOfModule(moduleSymbol);
  const parts: PartRequest[] = [];
  for (const exportName of request.exportNames) {
    const rootSymbol = moduleExports.find((exported) => exported.name === exportName);
    if (rootSymbol === undefined) {
      addProblem(problems, `${request.entryFile}: does not export "${exportName}"`);
      continue;
    }
    const rootType = checker.getTypeOfSymbol(rootSymbol);
    if (rootType === undefined || rootType.isErrorType()) {
      addProblem(problems, `${exportName}: exported value has an unresolvable type`);
      continue;
    }
    if (callSignature(checker, rootType) !== null) {
      parts.push({ name: exportName, type: rootType });
      continue;
    }
    const start = parts.length;
    for (const member of checker.getPropertiesOfType(rootType)) {
      const memberType = checker.getTypeOfSymbol(member);
      if (memberType === undefined || callSignature(checker, memberType) === null) continue;
      parts.push({ name: `${exportName}.${member.name}`, type: memberType });
    }
    if (parts.length === start) {
      addProblem(problems, `${exportName}: no renderable parts were found on the exported namespace`);
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
  /** Declaring file of the part's call signature, when it has one. */
  readonly declarationPaths: readonly string[];
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
  /** The parts the docs publish, in walk order. */
  readonly parts: readonly ApiPart[];
  /** One entry per traversed part, described or not. */
  readonly partApis: readonly LibraryPartApi[];
};

function describePart(
  context: LibraryProject,
  request: PartRequest,
  signature: Signature | null,
  source: PartSource | null,
  hasPropsParameter: boolean,
  propsResolved: boolean,
  props: ReadonlyMap<string, TsSymbol>,
  forwarded: PartForwarded,
  problems: ProblemLog
): ApiPart | null {
  const { checker } = context;
  if (signature === null) {
    problems.add(`${request.name}: no call signature — it does not look like a component`);
    return null;
  }
  if (source === null) {
    problems.add(`${request.name}: could not resolve the declaring source file`);
    return null;
  }
  if (!hasPropsParameter) {
    return {
      name: request.name,
      rsc: source.rsc,
      sourcePath: source.sourcePath,
      props: [],
      forwardedFrom: [],
      forwardedCount: 0,
    };
  }
  if (!propsResolved) {
    problems.add(`${request.name}: props type is unresolvable`);
    return null;
  }

  const rows: ApiProp[] = [];
  for (const property of props.values()) {
    // A prop with no declaration at all is synthesised by `VariantProps` over a library
    // `tv` recipe: there is no declaration site to hang JSDoc on, so its printed union
    // is the documentation and the JSDoc gate does not apply.
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

  rows.sort((left, right) => left.name.localeCompare(right.name));

  return {
    name: request.name,
    rsc: source.rsc,
    sourcePath: source.sourcePath,
    props: rows,
    forwardedFrom: forwarded.from,
    forwardedCount: forwarded.count,
  };
}

/** Reads every fact one part yields, resolving its props type exactly once. */
function extractPart(context: LibraryProject, request: PartRequest, problems: ProblemLog): LibraryPartApi {
  const { checker } = context;
  const signature = callSignature(checker, request.type);
  const source = signature === null ? null : readPartSource(context, signature);
  const declarationPaths = signature?.declaration === undefined ? [] : [signature.declaration.path];
  const parameter = signature?.getParameters()[0];
  const declared = parameter === undefined ? undefined : checker.getTypeOfSymbol(parameter);
  const propsType = declared === undefined || declared.isErrorType() ? null : declared;
  const props = new Map<string, TsSymbol>();
  if (propsType !== null) {
    for (const property of checker.getPropertiesOfType(propsType)) {
      props.set(property.name, property);
    }
  }
  const forwarded = props.size === 0 ? emptyForwarded : forwardedOfProps(context, props.values());
  return {
    name: request.name,
    declarationPaths,
    source,
    forwarded,
    props,
    part: describePart(
      context,
      request,
      signature,
      source,
      parameter !== undefined,
      propsType !== null,
      props,
      forwarded,
      problems
    ),
  };
}

/**
 * Resolves one component's public surface from an explicit list of export names:
 * a single part for a callable, or one part per member for a namespace compound
 * (`Dialog.Root`, `Dialog.Content`, …). Companions (`VerticalTable` next to `Table`)
 * are included only when the caller names them.
 *
 * The entry is walked once and every fact — rows, implementation source, RSC
 * status, forwarded summary, accepted prop symbols — is read from that one walk.
 */
export function extractComponentApi(
  context: LibraryProject,
  request: LibraryApiRequest,
  problems: ProblemLog
): ComponentApi {
  const componentRequest = { entryFile: request.entryFile, exportNames: request.exportNames };
  const partApis = componentPartRequests(context, componentRequest, problems).map((part) =>
    extractPart(context, part, problems)
  );
  return {
    slug: request.slug,
    parts: partApis.flatMap((entry) => (entry.part === null ? [] : [entry.part])),
    partApis,
  };
}

/** Extracts all requested components using one open checker project. */
export function extractLibraryApi(
  context: LibraryProject,
  components: readonly LibraryApiRequest[],
  problems: ProblemLog
): readonly ComponentApi[] {
  return components.map((component) => extractComponentApi(context, component, problems));
}
