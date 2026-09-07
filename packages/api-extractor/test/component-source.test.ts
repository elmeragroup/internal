import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type {
  BackendCompilerOperations,
  BackendDeclarationOwnership,
  BackendNodeFacts,
  BackendNodeHandle,
  BackendNodeReference,
  BackendSignatureHandle,
  BackendSymbolFacts,
  BackendSymbolHandle,
  BackendTypeHandle,
} from "../src/backend/contracts.ts";
import { inspectRequestedComponentSources } from "../src/parse/component-source.ts";
import {
  componentSourceFixture,
  exportSymbol,
  inspectNative,
  primaryNode,
  withSession,
} from "./support/component-source.ts";

const inputPath = componentSourceFixture("input.tsx");
const renderPath = componentSourceFixture("render.tsx");
const declaredPath = componentSourceFixture("declared.d.ts");
const defaultExpressionPath = componentSourceFixture("default-expression.ts");

const reactMemoFacts = {
  identity: { name: "memo", namespaces: ["React"] },
  moduleOrigin: { moduleSpecifier: "react", packageName: "react", external: true },
} as const;

const reactForwardRefFacts = {
  identity: { name: "forwardRef", namespaces: ["React"] },
  moduleOrigin: { moduleSpecifier: "react", packageName: "react", external: true },
} as const;

const sessionKey = Symbol("component-source-double");

function nodeHandle(id: number): BackendNodeHandle {
  // SAFETY: test doubles only need handle identity.
  return { kind: "node", id, session: sessionKey } as BackendNodeHandle;
}

function symbolHandle(id: number): BackendSymbolHandle {
  // SAFETY: test doubles only need handle identity.
  return { kind: "symbol", id, session: sessionKey } as BackendSymbolHandle;
}

function typeHandle(id: number): BackendTypeHandle {
  // SAFETY: test doubles only need handle identity.
  return { kind: "type", id, session: sessionKey } as BackendTypeHandle;
}

const unusedType = typeHandle(0);

function baseFacts(kind: BackendNodeFacts["kind"], extra: Partial<BackendNodeFacts> = {}): BackendNodeFacts {
  return { kind, text: kind, filePath: "/virtual/input.tsx", line: 1, column: 1, ...extra };
}

function symbolFacts(
  name: string,
  declarations: readonly BackendNodeHandle[],
  extra: Partial<BackendSymbolFacts> = {}
): BackendSymbolFacts {
  return { name, flags: [], declarationPaths: ["/virtual/input.tsx"], declarations, ...extra };
}

function operations(config: {
  readonly symbols?: Map<BackendSymbolHandle, BackendSymbolFacts>;
  readonly nodes?: Map<BackendNodeReference, BackendNodeFacts>;
  readonly types?: Map<BackendSymbolHandle, BackendTypeHandle>;
  readonly properties?: Map<BackendTypeHandle, readonly BackendSymbolHandle[]>;
  /** File ownership per node; unlisted nodes are project-owned. */
  readonly ownership?: Map<BackendNodeReference, BackendDeclarationOwnership>;
}): Pick<
  BackendCompilerOperations,
  "declarationOwnership" | "nodeFacts" | "symbolFacts" | "typeOfSymbol" | "propertiesOfType"
> {
  return {
    declarationOwnership: (node) => config.ownership?.get(node) ?? { kind: "project" },
    nodeFacts: (node) => {
      const facts = config.nodes?.get(node);
      if (facts === undefined) throw new Error("missing node facts");
      return facts;
    },
    symbolFacts: (symbol) => {
      const facts = config.symbols?.get(symbol);
      if (facts === undefined) throw new Error("missing symbol facts");
      return facts;
    },
    typeOfSymbol: (symbol) => config.types?.get(symbol),
    propertiesOfType: (type) => config.properties?.get(type) ?? [],
  };
}

describe("component source backend facts", () => {
  it("preserves nested outer-property defaults separately from semantic binding defaults", () => {
    withSession(inputPath, (session, draft) => {
      const declaration = primaryNode(session, exportSymbol(draft, "DirectFunction"));
      const facts = session.compiler.nodeFacts(declaration);
      expect(facts.hasImplementationBody).toBe(true);
      const parameter = facts.parameters?.[0];
      if (parameter === undefined) throw new Error("Missing parameter");
      const parameterFacts = session.compiler.nodeFacts(parameter);
      expect(parameterFacts.sourceBindingDefaults).toEqual([
        { name: "label", initializerText: '"direct"' },
        { name: "options", initializerText: "{}" },
      ]);
      expect(parameterFacts.bindingDefaults).toEqual([{ name: "label", initializerText: '"direct"' }]);
    });
  });

  it("follows shorthand assignments to the referenced value rather than the property symbol", () => {
    withSession(inputPath, (session, draft) => {
      const compound = exportSymbol(draft, "ShorthandCompound");
      const type = session.compiler.typeOfSymbol(compound, false);
      if (type === undefined) throw new Error("Missing compound type");
      const member = session.compiler
        .propertiesOfType(type)
        .find((candidate) => session.compiler.symbolFacts(candidate).name === "DirectFunction");
      if (member === undefined) throw new Error("Missing shorthand member");
      const memberDeclaration = primaryNode(session, member);
      const facts = session.compiler.nodeFacts(memberDeclaration);
      expect(facts.kind).toBe("property");
      expect(facts.referencedValueSymbol).toBe(exportSymbol(draft, "DirectFunction"));
      expect(session.compiler.symbolFacts(facts.referencedValueSymbol ?? member).name).toBe("DirectFunction");
    });
  });

  it("follows explicit property initializers and aliased identifiers", () => {
    withSession(inputPath, (session, draft) => {
      const compound = exportSymbol(draft, "ExplicitCompound");
      const type = session.compiler.typeOfSymbol(compound, false);
      if (type === undefined) throw new Error("Missing compound type");
      const member = session.compiler
        .propertiesOfType(type)
        .find((candidate) => session.compiler.symbolFacts(candidate).name === "Root");
      if (member === undefined) throw new Error("Missing explicit member");
      const memberFacts = session.compiler.nodeFacts(primaryNode(session, member));
      expect(memberFacts.initializer).toBeDefined();
      if (memberFacts.initializer === undefined) throw new Error("Missing initializer");
      const initializerFacts = session.compiler.nodeFacts(memberFacts.initializer);
      expect(initializerFacts.referencedValueSymbol).toBe(exportSymbol(draft, "DirectFunction"));

      const aliased = session.compiler.nodeFacts(primaryNode(session, exportSymbol(draft, "AliasedValue")));
      if (aliased.initializer === undefined) throw new Error("Missing aliased initializer");
      const referenced = session.compiler.nodeFacts(aliased.initializer).referencedValueSymbol;
      if (referenced === undefined) throw new Error("Missing aliased referenced symbol");
      expect(session.compiler.symbolFacts(referenced).name).toBe("aliasedRender");
      const aliasedDeclaration = primaryNode(session, referenced);
      const aliasedInitializer = session.compiler.nodeFacts(aliasedDeclaration).initializer;
      if (aliasedInitializer === undefined) throw new Error("Missing inner aliased initializer");
      expect(session.compiler.nodeFacts(aliasedInitializer).referencedValueSymbol).toBe(
        exportSymbol(draft, "DirectFunction")
      );
    });
  });

  it("exposes transparent inner expressions and implementation bodies", () => {
    withSession(inputPath, (session, draft) => {
      const wrapped = session.compiler.nodeFacts(
        primaryNode(session, exportSymbol(draft, "ParenthesizedWrapped"))
      );
      if (wrapped.initializer === undefined) throw new Error("Missing wrapper call");
      const call = session.compiler.nodeFacts(wrapped.initializer);
      const argument = call.arguments?.[0];
      if (argument === undefined) throw new Error("Missing wrapper argument");
      expect(session.compiler.nodeFacts(argument).innerExpression).toBeDefined();

      const overload = exportSymbol(draft, "OverloadedWrapped");
      const overloadInit = session.compiler.nodeFacts(primaryNode(session, overload)).initializer;
      if (overloadInit === undefined) throw new Error("Missing overloaded wrapper");
      const render = session.compiler.nodeFacts(overloadInit).arguments?.[0];
      if (render === undefined) throw new Error("Missing overloaded render");
      const renderSymbol = session.compiler.nodeFacts(render).referencedValueSymbol;
      if (renderSymbol === undefined) throw new Error("Missing overloaded symbol");
      const bodies = session.compiler
        .symbolFacts(renderSymbol)
        .declarations.map((declaration) => session.compiler.nodeFacts(declaration));
      expect(bodies.filter((facts) => facts.hasImplementationBody === true)).toHaveLength(1);
      expect(bodies.filter((facts) => facts.hasImplementationBody !== true).length).toBeGreaterThan(0);
    });
  });
});

describe("component source resolver doubles", () => {
  const filePath = "/virtual/input.tsx";
  const fn = nodeHandle(1);
  const param = nodeHandle(2);
  const symbol = symbolHandle(1);

  it("resolves a direct function, zero-parameter function, and preserves request order", () => {
    const zero = nodeHandle(3);
    const zeroSymbol = symbolHandle(2);
    const result = inspectRequestedComponentSources(
      {
        name: "input",
        exports: [
          { name: "Direct", symbol },
          { name: "Empty", symbol: zeroSymbol },
        ],
      },
      operations({
        symbols: new Map([
          [symbol, symbolFacts("Direct", [fn], { valueDeclaration: fn })],
          [zeroSymbol, symbolFacts("Empty", [zero], { valueDeclaration: zero })],
        ]),
        nodes: new Map([
          [
            fn,
            baseFacts("function", {
              hasImplementationBody: true,
              parameters: [param],
              filePath,
            }),
          ],
          [
            param,
            baseFacts("parameter", {
              sourceBindingDefaults: [{ name: "label", initializerText: '"x"' }],
            }),
          ],
          [zero, baseFacts("function", { hasImplementationBody: true, filePath })],
        ]),
      }),
      [{ exportName: "Empty" }, { exportName: "Direct" }, { exportName: "Direct" }]
    );
    expect(result).toEqual([
      { status: "resolved", filePath, defaults: [] },
      { status: "resolved", filePath, defaults: [{ name: "label", initializerText: '"x"' }] },
      { status: "resolved", filePath, defaults: [{ name: "label", initializerText: '"x"' }] },
    ]);
  });

  it("unwraps nested React wrappers and ignores comparator arguments", () => {
    const variable = nodeHandle(10);
    const memoCall = nodeHandle(11);
    const forwardCall = nodeHandle(12);
    const render = nodeHandle(13);
    const comparator = nodeHandle(14);
    const variableSymbol = symbolHandle(10);
    const memoSymbol = symbolHandle(11);
    const forwardSymbol = symbolHandle(12);
    const result = inspectRequestedComponentSources(
      { name: "input", exports: [{ name: "Nested", symbol: variableSymbol }] },
      operations({
        symbols: new Map([
          [variableSymbol, symbolFacts("Nested", [variable], { valueDeclaration: variable })],
        ]),
        nodes: new Map([
          [variable, baseFacts("variable", { initializer: memoCall })],
          [
            memoCall,
            baseFacts("callExpression", {
              arguments: [forwardCall, comparator],
              calleeFacts: { symbol: memoSymbol, ...reactMemoFacts },
            }),
          ],
          [
            forwardCall,
            baseFacts("callExpression", {
              arguments: [render],
              calleeFacts: { symbol: forwardSymbol, ...reactForwardRefFacts },
            }),
          ],
          [
            render,
            baseFacts("functionLike", {
              hasImplementationBody: true,
              parameters: [param],
              filePath,
            }),
          ],
          [
            param,
            baseFacts("parameter", { sourceBindingDefaults: [{ name: "label", initializerText: '"n"' }] }),
          ],
          [
            comparator,
            baseFacts("functionLike", {
              hasImplementationBody: true,
              parameters: [param],
              filePath: "/virtual/comparator.tsx",
            }),
          ],
        ]),
      }),
      [{ exportName: "Nested" }]
    );
    expect(result).toEqual([
      { status: "resolved", filePath, defaults: [{ name: "label", initializerText: '"n"' }] },
    ]);
  });

  it("follows shorthand members, explicit members, identifiers, and transparent syntax", () => {
    const compound = symbolHandle(20);
    const compoundNode = nodeHandle(20);
    const compoundType = typeHandle(20);
    const shorthandMember = symbolHandle(21);
    const shorthandNode = nodeHandle(21);
    const explicitMember = symbolHandle(22);
    const explicitNode = nodeHandle(22);
    const ident = nodeHandle(23);
    const paren = nodeHandle(24);
    const inner = nodeHandle(25);
    const target = symbolHandle(1);
    const ops = operations({
      symbols: new Map([
        [compound, symbolFacts("Compound", [compoundNode], { valueDeclaration: compoundNode })],
        [shorthandMember, symbolFacts("Root", [shorthandNode], { valueDeclaration: shorthandNode })],
        [explicitMember, symbolFacts("Item", [explicitNode], { valueDeclaration: explicitNode })],
        [target, symbolFacts("Direct", [fn], { valueDeclaration: fn })],
      ]),
      nodes: new Map([
        [compoundNode, baseFacts("variable")],
        [shorthandNode, baseFacts("property", { referencedValueSymbol: target })],
        [explicitNode, baseFacts("property", { initializer: ident })],
        [ident, baseFacts("unknown", { referencedValueSymbol: target })],
        [paren, baseFacts("unknown", { innerExpression: inner })],
        [inner, baseFacts("functionLike", { hasImplementationBody: true, filePath })],
        [fn, baseFacts("function", { hasImplementationBody: true, filePath })],
      ]),
      types: new Map([[compound, compoundType]]),
      properties: new Map([[compoundType, [shorthandMember, explicitMember]]]),
    });
    expect(
      inspectRequestedComponentSources(
        { name: "input", exports: [{ name: "Compound", symbol: compound }] },
        ops,
        [
          { exportName: "Compound", memberName: "Root" },
          { exportName: "Compound", memberName: "Item" },
        ]
      )
    ).toEqual([
      { status: "resolved", filePath, defaults: [] },
      { status: "resolved", filePath, defaults: [] },
    ]);
    expect(
      inspectRequestedComponentSources(
        { name: "input", exports: [{ name: "Transparent", symbol }] },
        operations({
          symbols: new Map([[symbol, symbolFacts("Transparent", [paren], { valueDeclaration: paren })]]),
          nodes: new Map([
            [paren, baseFacts("unknown", { innerExpression: inner })],
            [inner, baseFacts("functionLike", { hasImplementationBody: true, filePath })],
          ]),
        }),
        [{ exportName: "Transparent" }]
      )
    ).toEqual([{ status: "resolved", filePath, defaults: [] }]);
  });

  it("returns deterministic unresolved results for missing, unsupported, cyclic, and ambiguous cases", () => {
    const cycleA = symbolHandle(30);
    const cycleB = symbolHandle(31);
    const nodeA = nodeHandle(30);
    const nodeB = nodeHandle(31);
    const identA = nodeHandle(32);
    const identB = nodeHandle(33);
    const declared = nodeHandle(34);
    const declaredSymbol = symbolHandle(34);
    const wrapCall = nodeHandle(35);
    const wrapSymbol = symbolHandle(35);
    const custom = symbolHandle(36);
    const implOne = nodeHandle(36);
    const implTwo = nodeHandle(37);
    const ambiguous = symbolHandle(37);
    const result = inspectRequestedComponentSources(
      {
        name: "input",
        exports: [
          { name: "Cycle", symbol: cycleA },
          { name: "Declared", symbol: declaredSymbol },
          { name: "Custom", symbol: wrapSymbol },
          { name: "Ambiguous", symbol: ambiguous },
          { name: "Present", symbol },
        ],
        warnings: [
          {
            code: "unresolved-re-export",
            reason: "ambiguous",
            name: "Starred",
            filePath,
            line: 1,
            column: 1,
            parsedSymbolStack: [filePath],
          },
          {
            code: "unresolved-re-export",
            reason: "missing-target",
            name: "MissingReexport",
            filePath,
            line: 1,
            column: 1,
            parsedSymbolStack: [filePath],
          },
          {
            code: "missing-default-export-symbol",
            sourceText: "memo(() => null)",
            filePath,
            line: 1,
            column: 1,
            parsedSymbolStack: [filePath],
          },
        ],
      },
      operations({
        symbols: new Map([
          [cycleA, symbolFacts("Cycle", [nodeA], { valueDeclaration: nodeA })],
          [cycleB, symbolFacts("Other", [nodeB], { valueDeclaration: nodeB })],
          [declaredSymbol, symbolFacts("Declared", [declared], { valueDeclaration: declared })],
          [wrapSymbol, symbolFacts("Custom", [wrapCall], { valueDeclaration: wrapCall })],
          [ambiguous, symbolFacts("Ambiguous", [implOne, implTwo])],
          [symbol, symbolFacts("Present", [fn], { valueDeclaration: fn })],
        ]),
        nodes: new Map([
          [nodeA, baseFacts("variable", { initializer: identB })],
          [nodeB, baseFacts("variable", { initializer: identA })],
          [identA, baseFacts("unknown", { referencedValueSymbol: cycleA })],
          [identB, baseFacts("unknown", { referencedValueSymbol: cycleB })],
          [declared, baseFacts("function", { hasImplementationBody: false, filePath })],
          [
            wrapCall,
            baseFacts("callExpression", {
              arguments: [fn],
              calleeFacts: {
                symbol: custom,
                identity: { name: "memo", namespaces: ["NotReact"] },
                moduleOrigin: { moduleSpecifier: "local", packageName: "local", external: false },
              },
            }),
          ],
          [fn, baseFacts("function", { hasImplementationBody: true, filePath })],
          [implOne, baseFacts("function", { hasImplementationBody: true, filePath })],
          [
            implTwo,
            baseFacts("functionLike", { hasImplementationBody: true, filePath: "/virtual/other.tsx" }),
          ],
        ]),
        types: new Map([[symbol, unusedType]]),
      }),
      [
        { exportName: "Missing" },
        { exportName: "Present", memberName: "nope" },
        { exportName: "Declared" },
        { exportName: "Custom" },
        { exportName: "default" },
        { exportName: "MissingReexport" },
        { exportName: "Starred" },
        { exportName: "Cycle" },
        { exportName: "Ambiguous" },
        { exportName: "Present" },
      ]
    );
    expect(result.map((entry) => (entry.status === "unresolved" ? entry.reason : entry.status))).toEqual([
      "export-not-found",
      "member-not-found",
      "no-implementation",
      "unsupported-wrapper",
      "unsupported-default-expression",
      "unresolved-export",
      "ambiguous-export",
      "cycle",
      "ambiguous-implementation",
      "resolved",
    ]);
  });

  it("publishes dependency declarations from the innermost project module that forwards them", () => {
    const declared = nodeHandle(40);
    const declaredSymbol = symbolHandle(40);
    const alias = nodeHandle(41);
    const aliasSymbol = symbolHandle(41);
    const aliasIdentifier = nodeHandle(42);
    const projectDeclared = nodeHandle(43);
    const projectSymbol = symbolHandle(43);
    const ops = operations({
      symbols: new Map([
        [declaredSymbol, symbolFacts("Forwarded", [declared], { valueDeclaration: declared })],
        [aliasSymbol, symbolFacts("Aliased", [alias], { valueDeclaration: alias })],
        [projectSymbol, symbolFacts("Declared", [projectDeclared], { valueDeclaration: projectDeclared })],
      ]),
      nodes: new Map([
        [
          declared,
          baseFacts("function", {
            hasImplementationBody: false,
            filePath: "/virtual/node_modules/dep-aria/index.d.ts",
          }),
        ],
        [alias, baseFacts("variable", { initializer: aliasIdentifier, filePath: "/virtual/facade.ts" })],
        [
          aliasIdentifier,
          baseFacts("unknown", { referencedValueSymbol: declaredSymbol, filePath: "/virtual/facade.ts" }),
        ],
        [projectDeclared, baseFacts("function", { hasImplementationBody: false })],
      ]),
      ownership: new Map([[declared, { kind: "dependency", packageName: "dep-aria" }]]),
    });
    expect(
      inspectRequestedComponentSources(
        {
          name: "input",
          exports: [
            { name: "Forwarded", symbol: declaredSymbol, forwardingModulePath: "/virtual/facade.ts" },
            { name: "Aliased", symbol: aliasSymbol, forwardingModulePath: "/virtual/input.tsx" },
            { name: "Unforwarded", symbol: declaredSymbol },
            { name: "Declared", symbol: projectSymbol, forwardingModulePath: "/virtual/input.tsx" },
          ],
        },
        ops,
        [
          { exportName: "Forwarded" },
          { exportName: "Aliased" },
          { exportName: "Unforwarded" },
          { exportName: "Declared" },
        ]
      )
    ).toEqual([
      { status: "forwarded", filePath: "/virtual/facade.ts", packageName: "dep-aria" },
      { status: "forwarded", filePath: "/virtual/facade.ts", packageName: "dep-aria" },
      { status: "unresolved", reason: "no-implementation" },
      { status: "unresolved", reason: "no-implementation" },
    ]);
  });

  it("does not let unrelated module-walk warnings block a different request", () => {
    const result = inspectRequestedComponentSources(
      {
        name: "input",
        exports: [{ name: "Direct", symbol }],
        warnings: [
          {
            code: "unresolved-re-export",
            reason: "ambiguous",
            name: "Other",
            filePath,
            line: 1,
            column: 1,
            parsedSymbolStack: [filePath],
          },
        ],
      },
      operations({
        symbols: new Map([[symbol, symbolFacts("Direct", [fn], { valueDeclaration: fn })]]),
        nodes: new Map([[fn, baseFacts("function", { hasImplementationBody: true, filePath })]]),
      }),
      [{ exportName: "Direct" }]
    );
    expect(result).toEqual([{ status: "resolved", filePath, defaults: [] }]);
  });
});

describe("component source native inspection", () => {
  it("follows namespace and object property references to the authored implementation", async () => {
    expect(
      await inspectNative(inputPath, [
        { exportName: "NamespaceWrapped" },
        { exportName: "PropertyAlias" },
        { exportName: "PropertyWrapped" },
      ])
    ).toEqual(
      Array.from({ length: 3 }, () => ({
        status: "resolved",
        filePath: renderPath,
        defaults: [{ name: "label", initializerText: '"imported"' }],
      }))
    );
  });

  it("distinguishes semicolon-free object return annotations from implementation bodies", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "component-source-body-"));
    try {
      const config = resolve(root, "tsconfig.json");
      const declarations = resolve(root, "declared.d.ts");
      const implementations = resolve(root, "implemented.ts");
      await writeFile(
        config,
        JSON.stringify({ compilerOptions: { types: [], strict: true }, include: ["*.ts"] })
      );
      await writeFile(
        declarations,
        `export declare function Declared(): { value: string }
export declare function Commented(): { value: string } // no body
`
      );
      await writeFile(
        implementations,
        `export function Overloaded(props: { label?: string }): { value: string }
export function Overloaded({ label = "actual" }: { label?: string }) {
  return { value: label };
}
export function CommentAfterBody() { return "value"; } // implementation
`
      );
      expect(
        await inspectNative(declarations, [{ exportName: "Declared" }, { exportName: "Commented" }], config)
      ).toEqual([
        { status: "unresolved", reason: "no-implementation" },
        { status: "unresolved", reason: "no-implementation" },
      ]);
      expect(
        await inspectNative(
          implementations,
          [{ exportName: "Overloaded" }, { exportName: "CommentAfterBody" }],
          config
        )
      ).toEqual([
        {
          status: "resolved",
          filePath: implementations,
          defaults: [{ name: "label", initializerText: '"actual"' }],
        },
        { status: "resolved", filePath: implementations, defaults: [] },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers React alias identity, imported implementations, and compound members", async () => {
    const result = await inspectNative(inputPath, [
      { exportName: "DirectFunction" },
      { exportName: "DirectArrow" },
      { exportName: "ZeroParameter" },
      { exportName: "NestedWrapped" },
      { exportName: "AliasWrapped" },
      { exportName: "ImportedWrapped" },
      { exportName: "ExplicitCompound", memberName: "Root" },
      { exportName: "ShorthandCompound", memberName: "DirectFunction" },
      { exportName: "ComparedWrapped" },
      { exportName: "ParenthesizedWrapped" },
      { exportName: "AssertionWrapped" },
      { exportName: "SatisfiesWrapped" },
      { exportName: "NonNullWrapped" },
      { exportName: "WrappedOptions" },
      { exportName: "OverloadedWrapped" },
      { exportName: "AliasedValue" },
      { exportName: "Renamed" },
      { exportName: "default" },
      { exportName: "FakeMemo" },
    ]);
    const resolved = result.filter((entry) => entry.status === "resolved");
    expect(resolved).toHaveLength(18);
    expect(resolved.every((entry) => !entry.filePath.includes("node_modules"))).toBe(true);
    expect(result[0]).toEqual({
      status: "resolved",
      filePath: inputPath,
      defaults: [
        { name: "label", initializerText: '"direct"' },
        { name: "options", initializerText: "{}" },
      ],
    });
    expect(result[3]).toMatchObject({
      status: "resolved",
      filePath: inputPath,
      defaults: [{ name: "label", initializerText: '"nested"' }],
    });
    expect(result[4]).toMatchObject({
      status: "resolved",
      defaults: [{ name: "label", initializerText: '"alias"' }],
    });
    expect(result[5]).toEqual({
      status: "resolved",
      filePath: renderPath,
      defaults: [{ name: "label", initializerText: '"imported"' }],
    });
    expect(result[8]).toMatchObject({
      status: "resolved",
      defaults: [{ name: "label", initializerText: '"compared"' }],
    });
    expect(result[13]).toMatchObject({
      status: "resolved",
      defaults: [{ name: "options", initializerText: "{}" }],
    });
    expect(result[14]).toMatchObject({
      status: "resolved",
      defaults: [
        { name: "text", initializerText: '"overload"' },
        { name: "count", initializerText: "0" },
      ],
    });
    expect(result[17]).toMatchObject({ status: "resolved", filePath: inputPath });
    expect(result[18]).toEqual({ status: "unresolved", reason: "unsupported-wrapper" });
  });

  it("returns unresolved results for declaration-only and unsupported default expressions", async () => {
    expect(await inspectNative(declaredPath, [{ exportName: "DeclaredOnly" }])).toEqual([
      { status: "unresolved", reason: "no-implementation" },
    ]);
    expect(await inspectNative(defaultExpressionPath, [{ exportName: "default" }])).toEqual([
      { status: "unresolved", reason: "unsupported-default-expression" },
    ]);
    expect(await inspectNative(inputPath, [])).toEqual([]);
    expect(
      await inspectNative(inputPath, [
        { exportName: "Missing" },
        { exportName: "ExplicitCompound", memberName: "nope" },
      ])
    ).toEqual([
      { status: "unresolved", reason: "export-not-found" },
      { status: "unresolved", reason: "member-not-found" },
    ]);
  });
});

describe("unused backend operations stay available for replacement compilers", () => {
  it("does not require semantic compiler operations on the source seam", () => {
    const compiler: BackendCompilerOperations = {
      setErrorContext: () => undefined,
      documentationOfSymbol: () => undefined,
      enumFacts: () => undefined,
      constructSignaturesOfType: () => [],
      documentationOfNode: () => undefined,
      documentationOfParameter: () => undefined,
      typeOfSymbol: () => undefined,
      typeAtNode: () => undefined,
      typeFacts: () => ({ flags: ["Unknown"], intrinsic: "unknown" }),
      symbolFacts: () => ({ name: "unused", flags: [], declarationPaths: [], declarations: [] }),
      symbolOrigin: () => ({ identity: { name: "unused", namespaces: [] } }),
      declaringParentIsClass: () => false,
      nodeFacts: () => baseFacts("unknown"),
      nodeKind: () => "unknown",
      typeNameFacts: () => undefined,
      // SAFETY: replacement graph identities are opaque sentinels.
      signaturesOfType: () => [] as readonly BackendSignatureHandle[],
      signatureFacts: () => ({ parameters: [], returnType: unusedType, typeParameters: [] }),
      declarationOwnership: () => ({ kind: "project" }),
      propertiesOfType: () => [],
      propertyType: () => undefined,
      indexSignaturesOfType: () => [],
      baseConstraintOfType: () => undefined,
      isArrayType: () => false,
      isReadonlyType: () => false,
      typeToString: () => "unknown",
    };
    expect(compiler.nodeFacts(nodeHandle(1)).kind).toBe("unknown");
  });
});
