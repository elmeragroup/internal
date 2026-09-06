/** Data supplied before an object property is included in the semantic model. */
export type ShouldIncludeData = {
  name: string;
  depth: number;
};

/** Data supplied before an object's shape is expanded in the semantic model. */
export type ShouldResolveObjectData = {
  /** Name of the object's type, or an empty string for an anonymous shape. */
  name: string;
  /** Number of properties the object would contribute to the output. */
  propertyCount: number;
  /** Depth of the type-resolution stack, counting every intermediate type. */
  depth: number;
  /** Number of property values traversed to reach this object. */
  propertyDepth: number;
};

export type ExtractorOptions = {
  readonly shouldInclude?: (data: ShouldIncludeData) => boolean | undefined;
  readonly shouldResolveObject?: (data: ShouldResolveObjectData) => boolean | undefined;
  /**
   * Expands no external types by default, every external type when `true`, or
   * only dependency declarations owned by an exact package name in the list.
   *
   * The two non-`true` forms apply different quantifiers, on purpose: `false`
   * summarizes a symbol as soon as ANY of its declarations is external
   * (upstream's `isSymbolExternal`), while a package list expands a symbol only
   * when EVERY declaration is project-owned or owned by a listed package, so a
   * symbol merged from a listed and an unlisted dependency stays summarized.
   */
  readonly includeExternalTypes?: boolean | readonly string[];
};

export const defaultExtractorOptions: Required<
  Pick<ExtractorOptions, "shouldResolveObject" | "includeExternalTypes">
> = {
  shouldResolveObject: (data) => (data.propertyDepth === 0 || data.propertyCount <= 50) && data.depth <= 10,
  includeExternalTypes: false,
};

export type ProjectFileSystemEntries = {
  readonly files: readonly string[];
  readonly directories: readonly string[];
};

export type ProjectFileSystem = {
  readonly directoryExists?: (directoryName: string) => boolean | undefined;
  readonly fileExists?: (fileName: string) => boolean | undefined;
  readonly getAccessibleEntries?: (directoryName: string) => ProjectFileSystemEntries | undefined;
  readonly readFile?: (fileName: string) => string | null | undefined;
  readonly realpath?: (path: string) => string | undefined;
  readonly writeFile?: (path: string, content: string) => void;
  readonly removeFile?: (path: string) => void;
};

export type OpenProjectOptions = {
  readonly tsconfigPath: string;
  readonly cwd?: string;
  readonly fileSystem?: ProjectFileSystem;
};
