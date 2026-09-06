import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type {
  BackendCompilerOperations,
  BackendExtractionSession,
  BackendNodeHandle,
  BackendSymbolHandle,
  BackendTypeHandle,
} from "../src/backend/contracts.ts";
import { openTsgoProject } from "../src/backend/ts7/project.ts";
import type { ProjectFileSystem } from "../src/options.ts";
import { extractFixture } from "./support/extract.ts";

const fixtureDirectory = resolve(import.meta.dirname, "fixtures");
const objectDirectory = resolve(fixtureDirectory, "object-api-documentation");
const objectTsconfigPath = resolve(objectDirectory, "tsconfig.json");
const objectInputPath = resolve(objectDirectory, "input.ts");
const enumTsconfigPath = resolve(fixtureDirectory, "object-api-tsconfig.json");
const enumInputPath = resolve(fixtureDirectory, "enum-members-values-and-docs/input.ts");
const packageDirectory = resolve(fixtureDirectory, "package-selective-external-types");
const packageTsconfigPath = resolve(packageDirectory, "tsconfig.json");
const packageInputPath = resolve(packageDirectory, "input.ts");

function diskFileSystem(): ProjectFileSystem {
  return {
    directoryExists: (directoryName) => existsSync(directoryName),
    fileExists: (fileName) => existsSync(fileName),
    getAccessibleEntries: (directoryName) => {
      if (!existsSync(directoryName)) return undefined;
      const entries = readdirSync(directoryName, { withFileTypes: true });
      return {
        files: entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
        directories: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      };
    },
    readFile: (fileName) => (existsSync(fileName) ? readFileSync(fileName, "utf8") : null),
    realpath: (path) => (existsSync(path) ? realpathSync(path) : undefined),
  };
}

function exportSymbol(
  session: BackendExtractionSession,
  inputPath: string,
  name: string
): BackendSymbolHandle {
  const symbol = session.readModule(inputPath).exports.find((entry) => entry.name === name)?.symbol;
  if (symbol === undefined) throw new Error(`Missing ${name} export in ${inputPath}`);
  return symbol;
}

function declaredType(compiler: BackendCompilerOperations, symbol: BackendSymbolHandle): BackendTypeHandle {
  const type = compiler.typeOfSymbol(symbol, true) ?? compiler.typeOfSymbol(symbol, false);
  if (type === undefined) throw new Error("Missing declared type");
  return type;
}

function memberDeclaration(
  compiler: BackendCompilerOperations,
  type: BackendTypeHandle,
  name: string
): BackendNodeHandle {
  const member = compiler.enumFacts(type)?.members.find((entry) => entry.name === name);
  const declaration = member?.declaration;
  if (declaration === undefined) throw new Error(`Missing ${name} enum member declaration`);
  return declaration;
}

describe("point-shaped backend queries", () => {
  it("answers object member facts independently for each property", () => {
    const project = openTsgoProject({
      tsconfigPath: objectTsconfigPath,
      fileSystem: diskFileSystem(),
    });
    try {
      const session = project.openExtraction();
      const compiler = session.compiler;
      const options = declaredType(compiler, exportSymbol(session, objectInputPath, "Options"));
      const properties = compiler.propertiesOfType(options);
      expect(properties.length).toBeGreaterThan(1);

      const names = properties.map((property) => compiler.symbolFacts(property).name);
      expect(names).toEqual(expect.arrayContaining(["label", "nested", "format"]));
      expect(new Set(names).size).toBe(names.length);

      const propertyTypes = properties.map((property) => compiler.propertyType(property));
      expect(propertyTypes.some((type) => type !== undefined)).toBe(true);

      const declarations = properties.flatMap((property) => compiler.symbolFacts(property).declarations);
      expect(declarations.length).toBeGreaterThan(1);
      const declarationKinds = declarations.map((declaration) => compiler.nodeFacts(declaration).kind);
      expect(declarationKinds).toEqual(expect.arrayContaining(["property", "methodSignature"]));
      const ownerships = declarations.map((declaration) => compiler.declarationOwnership(declaration).kind);
      expect(ownerships).toEqual(expect.arrayContaining(["project"]));

      expect(declarations.map((declaration) => compiler.documentationOfNode(declaration))).toHaveLength(
        declarations.length
      );
      session.close();
    } finally {
      project.close();
    }
  });

  it("isolates a documentation miss without failing neighboring enum members", () => {
    const project = openTsgoProject({
      tsconfigPath: enumTsconfigPath,
      fileSystem: diskFileSystem(),
    });
    try {
      const session = project.openExtraction();
      const compiler = session.compiler;
      const flags = declaredType(compiler, exportSymbol(session, enumInputPath, "Flags"));
      const side = declaredType(compiler, exportSymbol(session, enumInputPath, "Side"));
      const enumFacts = compiler.enumFacts(flags);
      if (enumFacts === undefined) throw new Error("Missing Flags enum facts");
      const memberNames = enumFacts.members.map((member) => compiler.symbolFacts(member.symbol).name);
      expect(memberNames).toEqual(enumFacts.members.map((member) => member.name));
      expect(compiler.enumFacts(flags)?.warnings).toEqual(enumFacts.warnings);

      const mixedDocs = [
        memberDeclaration(compiler, side, "left"),
        memberDeclaration(compiler, flags, "flag1"),
        memberDeclaration(compiler, side, "right"),
      ];
      const docs = mixedDocs.map((declaration) => compiler.documentationOfNode(declaration));
      expect(docs[0]).toEqual(expect.objectContaining({ description: "Left side." }));
      expect(docs[1]).toBeUndefined();
      expect(docs[2]).toEqual(expect.objectContaining({ description: "Right side." }));
      session.close();
    } finally {
      project.close();
    }
  });

  it("classifies mixed declaration ownership independently per node", () => {
    const project = openTsgoProject({
      tsconfigPath: packageTsconfigPath,
      fileSystem: diskFileSystem(),
    });
    try {
      const session = project.openExtraction();
      const compiler = session.compiler;
      const wrapper = declaredType(compiler, exportSymbol(session, packageInputPath, "WrapperProps"));
      const properties = compiler.propertiesOfType(wrapper);
      const declarations = properties.flatMap((property) => compiler.symbolFacts(property).declarations);
      expect(declarations.length).toBeGreaterThan(1);
      const ownerships = declarations.map((declaration) => compiler.declarationOwnership(declaration));
      expect(ownerships.some((ownership) => ownership.kind === "project")).toBe(true);
      expect(ownerships.some((ownership) => ownership.kind !== "project")).toBe(true);
      session.close();
    } finally {
      project.close();
    }
  });

  it("extracts through ProjectExtractor on a virtual filesystem", async () => {
    const result = await extractFixture(
      { tsconfigPath: objectTsconfigPath, fileSystem: diskFileSystem() },
      objectInputPath
    );
    const options = result.module.exports.find((entry) => entry.name === "Options");
    expect(options?.type).toMatchObject({ kind: "object" });
    if (options?.type.kind !== "object") throw new Error("Options was not an object");
    expect(options.type.properties.map((property) => property.name)).toEqual(
      expect.arrayContaining(["label", "nested", "format"])
    );
    expect(result.warnings).toEqual([]);
  });
});
