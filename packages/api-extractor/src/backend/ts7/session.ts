import { resolve } from "node:path";
import type { Node, TypeNode } from "typescript/unstable/ast";
import { isTypeNode } from "typescript/unstable/ast/is";
import type {
  Checker,
  Program,
  Project,
  Signature,
  Symbol as TsSymbol,
  Type,
} from "typescript/unstable/sync";

import { BackendError } from "../../errors.ts";
import { definedFields } from "../../optional-fields.ts";
import { externalTypeSelectionAllowsOwnership, isExternalOwnership } from "../contracts.ts";
import type {
  BackendCompilerOperations,
  BackendDeclarationOwnership,
  BackendExternalTypeSelection,
  BackendModuleDraft,
  BackendNodeReference,
  BackendExtractionSession,
  BackendSignatureHandle,
  BackendSymbolHandle,
  BackendTypeHandle,
  BackendTypeNodeHandle,
} from "../contracts.ts";
import { HandleRegistry } from "../handles.ts";
import { createSessionFacts } from "./facts.ts";
import type { TsgoFactsSession, TsgoSessionFacts } from "./facts.ts";
import { PathNameOwnershipCache, sourceFileOwnership } from "./file-ownership.ts";
import { SessionFileTrees } from "./file-trees.ts";
import type { TsgoHeritageSession } from "./heritage.ts";
import { resolveModule } from "./module-resolution.ts";
import { readModule } from "./module.ts";
import type { TsgoModuleSession } from "./module.ts";
import { NodeHandleInterner } from "./node-handles.ts";
import type { SessionNodeReference } from "./node-handles.ts";
import type { PathIdentity } from "./path-identity.ts";

export class TsgoExtractionSession implements BackendExtractionSession {
  private readonly project: Project;
  private readonly checker: Checker;
  private readonly sourceFileMetadataCache = new Map<string, ReturnType<Program["getSourceFileMetadata"]>>();
  private readonly rootDirectory: string;
  private readonly projectRoot: string;
  private readonly provenanceRoot: string;
  private readonly cwd: string;
  private readonly pathIdentity: PathIdentity;
  private readonly externalTypes: BackendExternalTypeSelection;
  private readonly registry = new HandleRegistry();
  private readonly nodeInterner: NodeHandleInterner;
  private readonly symbolHandles = new Map<TsSymbol, BackendSymbolHandle>();
  private readonly symbolsAtNodes = new Map<Node, TsSymbol | null>();
  private readonly moduleExportsBySymbol = new Map<TsSymbol, readonly TsSymbol[]>();
  private readonly ownershipByPath = new Map<string, BackendDeclarationOwnership>();
  private readonly pathNameOwnership = new PathNameOwnershipCache();
  private readonly typeHandles = new Map<Type, BackendTypeHandle>();
  private readonly declarationPaths = new Map<string, string>();
  private readonly typeNodeHandles = new Map<TypeNode, BackendTypeNodeHandle>();
  private readonly signatureHandles = new Map<Signature, BackendSignatureHandle>();
  private onClose: ((session: TsgoExtractionSession) => void) | undefined;
  private readonly facts: TsgoSessionFacts;
  private readonly fileTrees: SessionFileTrees;
  private currentFilePath: string | undefined;
  private symbolStack: readonly string[] = [];
  private closed = false;

  readonly compiler: BackendCompilerOperations;

  constructor(
    project: Project,
    rootDirectory: string,
    projectRoot: string,
    provenanceRoot: string,
    cwd: string,
    pathIdentity: PathIdentity,
    externalTypes: BackendExternalTypeSelection,
    onClose: (session: TsgoExtractionSession) => void
  ) {
    this.project = project;
    this.checker = this.project.checker;
    this.rootDirectory = rootDirectory;
    this.projectRoot = projectRoot;
    this.provenanceRoot = provenanceRoot;
    this.cwd = cwd;
    this.pathIdentity = pathIdentity;
    this.externalTypes = externalTypes;
    this.onClose = onClose;
    this.fileTrees = new SessionFileTrees(
      this.project,
      (path) => this.isExternalPath(path),
      (path) => this.isSelectedPath(path)
    );
    this.nodeInterner = new NodeHandleInterner(
      this.registry,
      (path) => this.internedSourceFileName(path),
      (declaration) => this.fileTrees.resolve(declaration)
    );
    this.facts = createSessionFacts(this.factsContext(), this.heritageContext());
    this.compiler = {
      ...this.facts.operations,
      setErrorContext: (symbolStack) => (this.symbolStack = [...symbolStack]),
    };
  }

  private factsContext(): TsgoFactsSession {
    return {
      checker: this.checker,
      program: this.project.program,
      sourceFileMetadata: (path) => this.sourceFileMetadata(path),
      rootDirectory: this.provenanceRoot,
      ensureOpen: (operation) => this.ensureOpen(operation),
      symbol: (handle, operation) => this.symbol(handle, operation),
      type: (handle, operation) => this.type(handle, operation),
      signature: (handle, operation) => this.signature(handle, operation),
      node: (handle, operation) => this.node(handle, operation),
      symbolHandle: (symbol) => this.symbolHandle(symbol),
      typeHandle: (type) => this.typeHandle(type),
      typeHandlesFor: (types) => this.typeHandlesFor(types),
      nodeHandle: (node) => this.nodeInterner.nodeHandle(node),
      declarationHandle: (declaration) => this.nodeInterner.declarationHandle(declaration),
      declarationPath: (declaration) => this.internedSourceFileName(declaration.path),
      signatureHandle: (signature) => this.signatureHandle(signature),
      typeNodeHandle: (node) => this.typeNodeHandle(node),
      nodeReference: (node) => this.nodeReference(node),
      symbolAt: (node) => this.symbolAt(node),
      rawSymbolAt: (node) => this.rawSymbolAt(node),
      ownershipOfPath: (path) => this.ownershipOfPath(path),
      ownershipFromPathName: (path) => this.pathNameOwnership.classify(path),
      resolveNode: (node) => this.fileTrees.resolveSelected(node),
      nodePath: (node) => this.nodeRecord(node, "nodePath").path,
      compilerKind: (node) => this.nodeRecord(node, "nodeKind").kind,
    };
  }

  private heritageContext(): TsgoHeritageSession {
    return {
      checker: this.checker,
      isExternalPath: (path) => this.isExternalPath(path),
      symbolAt: (node) => this.rawSymbolAt(node),
      resolveDeclaration: (declaration) => this.fileTrees.resolve(declaration),
    };
  }

  private moduleContext(): TsgoModuleSession {
    return {
      project: this.project,
      checker: this.checker,
      rootDirectory: this.rootDirectory,
      cwd: this.cwd,
      ensureOpen: (operation) => this.ensureOpen(operation),
      isExternalPath: (path) => this.isExternalPath(path),
      sourceFile: (path) => this.fileTrees.sourceFile(path),
      resolveDeclaration: (declaration) => this.fileTrees.resolve(declaration),
      symbolAt: (node) => this.rawSymbolAt(node),
      moduleExports: (container) => this.moduleExports(container),
      symbolHandle: (symbol) => this.symbolHandle(symbol),
      documentationOfSymbol: (symbol) => this.compiler.documentationOfSymbol(symbol),
      heritageTypes: (declaration) =>
        declaration === undefined
          ? undefined
          : this.facts.heritageTypes(this.nodeInterner.nodeHandle(declaration)),
      sameSourceFile: (left, right) => this.pathIdentity.sameSourceFile(left, right),
    };
  }

  readModule(filePath: string): BackendModuleDraft {
    this.currentFilePath = resolve(this.cwd, filePath);
    return readModule(this.moduleContext(), filePath);
  }

  resolveModule(moduleSpecifier: string, containingFile: string) {
    return resolveModule(this.moduleContext(), moduleSpecifier, containingFile);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fileTrees.clear();
    this.facts.clear();
    this.registry.clear();
    this.nodeInterner.clear();
    this.sourceFileMetadataCache.clear();
    this.symbolHandles.clear();
    this.symbolsAtNodes.clear();
    this.moduleExportsBySymbol.clear();
    this.ownershipByPath.clear();
    this.pathNameOwnership.clear();
    this.typeHandles.clear();
    this.declarationPaths.clear();
    this.typeNodeHandles.clear();
    this.signatureHandles.clear();
    // Drop the project callback so a closed session cannot retain the native API.
    const onClose = this.onClose;
    this.onClose = undefined;
    onClose?.(this);
  }

  private ensureOpen(operation: string): void {
    if (!this.closed) return;
    const { operation: _operation, ...diagnostics } = this.context(operation);
    throw new BackendError({
      message: `Cannot use the TypeScript extraction session after it closed (${operation})`,
      cause: "The extraction handle registry has been cleared.",
      ...diagnostics,
    });
  }

  /** The operation name plus whatever file and symbol breadcrumb this session knows. */
  private context(operation: string) {
    return {
      operation,
      ...definedFields({
        filePath: this.currentFilePath,
        symbolStack: this.symbolStack.length === 0 ? undefined : [...this.symbolStack],
      }),
    };
  }

  private symbol(handle: BackendSymbolHandle, operation: string): TsSymbol {
    this.ensureOpen(operation);
    return this.registry.get(handle, "symbol", () => this.context(operation));
  }

  private type(handle: BackendTypeHandle, operation: string): Type {
    this.ensureOpen(operation);
    return this.registry.get(handle, "type", () => this.context(operation));
  }

  private signature(handle: BackendSignatureHandle, operation: string): Signature {
    this.ensureOpen(operation);
    return this.registry.get(handle, "signature", () => this.context(operation));
  }

  private node(handle: BackendNodeReference, operation: string): Node {
    this.ensureOpen(operation);
    const record = this.nodeRecord(handle, operation);
    const node = record.resolve();
    if (node === undefined) {
      const { operation: _operation, ...diagnostics } = this.context(operation);
      throw new BackendError({
        message: `Could not resolve a ${handle.kind} compiler handle in ${operation}`,
        cause: `The compiler declaration at ${record.path} is no longer available.`,
        ...diagnostics,
      });
    }
    if (handle.kind === "node") this.nodeInterner.rememberResolvedNode(node, handle);
    return node;
  }

  private nodeRecord(handle: BackendNodeReference, operation: string): SessionNodeReference {
    this.ensureOpen(operation);
    return handle.kind === "type-node"
      ? this.registry.get(handle, "type-node", () => this.context(operation))
      : this.registry.get(handle, "node", () => this.context(operation));
  }

  private nodeReference(node: Node): BackendNodeReference {
    return isTypeNode(node) ? this.typeNodeHandle(node) : this.nodeInterner.nodeHandle(node);
  }

  private typeNodeHandle(node: TypeNode): BackendTypeNodeHandle {
    return intern(this.typeNodeHandles, node, () =>
      this.registry.create("type-node", {
        deferred: false,
        kind: node.kind,
        path: node.getSourceFile().fileName,
        resolve: () => node,
      } satisfies SessionNodeReference)
    );
  }

  private symbolHandle(symbol: TsSymbol): BackendSymbolHandle {
    return intern(this.symbolHandles, symbol, () => this.registry.create("symbol", symbol));
  }
  private typeHandle(type: Type): BackendTypeHandle {
    return intern(this.typeHandles, type, () => this.registry.create("type", type));
  }
  private typeHandlesFor(types: readonly Type[]): readonly BackendTypeHandle[] {
    return types.map((type) => this.typeHandle(type));
  }
  private internedSourceFileName(path: string): string {
    return intern(this.declarationPaths, path, () =>
      this.pathIdentity.compilerSourceFileName(
        path,
        (candidate) => this.sourceFileMetadata(candidate) !== undefined
      )
    );
  }
  private sourceFileMetadata(path: string): ReturnType<Program["getSourceFileMetadata"]> {
    this.ensureOpen("sourceFileMetadata");
    if (this.sourceFileMetadataCache.has(path)) return this.sourceFileMetadataCache.get(path);
    const metadata = this.project.program.getSourceFileMetadata(path);
    this.sourceFileMetadataCache.set(path, metadata);
    return metadata;
  }
  private signatureHandle(signature: Signature): BackendSignatureHandle {
    return intern(this.signatureHandles, signature, () => this.registry.create("signature", signature));
  }
  private rawSymbolAt(node: Node): TsSymbol | undefined {
    const cached = this.symbolsAtNodes.get(node);
    if (cached !== undefined) return cached ?? undefined;
    const symbol = this.checker.getSymbolAtLocation(node);
    this.symbolsAtNodes.set(node, symbol ?? null);
    return symbol;
  }
  private symbolAt(node: Node): BackendSymbolHandle | undefined {
    const symbol = this.rawSymbolAt(node);
    return symbol === undefined ? undefined : this.symbolHandle(symbol);
  }
  private moduleExports(container: TsSymbol): readonly TsSymbol[] {
    return intern(this.moduleExportsBySymbol, container, () => [
      ...this.checker.getExportsOfModule(container),
    ]);
  }
  private ownershipOfPath(path: string): BackendDeclarationOwnership {
    return intern(this.ownershipByPath, path, () => sourceFileOwnership(path, this.sourceFileMetadata(path)));
  }
  private isExternalPath(path: string): boolean {
    return isExternalOwnership(this.ownershipOfPath(path));
  }
  /** Project files always; other owners only when this extraction's selection includes them. */
  private isSelectedPath(path: string): boolean {
    return externalTypeSelectionAllowsOwnership(this.ownershipOfPath(path), this.externalTypes);
  }
}

/** Get-or-create for the session's identity maps; `create` runs once per key. */
function intern<Key, Value>(entries: Map<Key, Value>, key: Key, create: () => Value): Value {
  const existing = entries.get(key);
  if (existing !== undefined) return existing;
  const value = create();
  entries.set(key, value);
  return value;
}
