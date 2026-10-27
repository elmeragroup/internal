import { dirname, resolve } from "node:path";
import { serverFS } from "tsrs/fs";
import type { FileSystemCallbacks } from "tsrs/fs";
import { API } from "tsrs/sync";
import type { Project } from "tsrs/sync";

import {
  BackendError,
  ConfigError,
  compilerStartError,
  projectMissingError,
  projectOpenError,
  safeCause,
} from "../../errors.ts";
import type { InternalOpenProjectOptions } from "../../internal/project-options.ts";
import { definedFields } from "../../optional-fields.ts";
import type { ProjectFileSystem } from "../../options.ts";
import type { BackendExtractionOptions, BackendProject, BackendTiming } from "../contracts.ts";
import { disabledTiming } from "../contracts.ts";
import { createPathIdentity } from "./path-identity.ts";
import type { PathIdentity } from "./path-identity.ts";
import { TsgoExtractionSession } from "./session.ts";

type OpenedProject = { readonly api: API; readonly project: Project };

/** Lifts a seam callback whose `undefined` means "ask the disk" into a compiler callback. */
function orUseOS<Result>(
  callback: ((path: string) => Result | undefined) | undefined
): ((path: string) => Result | typeof serverFS.useOS) | typeof serverFS.useOS {
  return callback === undefined ? serverFS.useOS : (path: string) => callback(path) ?? serverFS.useOS;
}

/**
 * Translates the public filesystem seam to the compiler's callbacks.
 *
 * The public seam returns `undefined` to fall back to the disk and `null` for a missing file. The
 * TypeScript 7.1 callbacks need every member and spell those outcomes `serverFS.useOS` and
 * `undefined`. Virtual files have no disk metadata, so a seam that answers existence also answers
 * `stat` through those answers.
 */
function toTypeScriptFileSystem(fileSystem: ProjectFileSystem | undefined): FileSystemCallbacks | undefined {
  if (fileSystem === undefined) return undefined;
  const { directoryExists, fileExists, getAccessibleEntries, readFile, realpath } = fileSystem;
  return {
    directoryExists: orUseOS(directoryExists),
    fileExists: orUseOS(fileExists),
    getAccessibleEntries:
      getAccessibleEntries === undefined
        ? serverFS.useOS
        : (directoryName: string) => {
            const entries = getAccessibleEntries(directoryName);
            return entries === undefined
              ? serverFS.useOS
              : {
                  files: [...entries.files],
                  directories: [...entries.directories],
                  symlinks: undefined,
                };
          },
    readFile:
      readFile === undefined
        ? serverFS.useOS
        : (fileName: string) => {
            const contents = readFile(fileName);
            if (contents === undefined) return serverFS.useOS;
            return contents ?? undefined;
          },
    realpath: orUseOS(realpath),
    stat: directoryExists === undefined && fileExists === undefined ? serverFS.useOS : serverFS.fakeStat,
    writeFile: fileSystem.writeFile ?? serverFS.useOS,
    removeFile: fileSystem.removeFile ?? serverFS.useOS,
  };
}

function createApi(options: InternalOpenProjectOptions): OpenedProject {
  const cwd = resolve(options.cwd ?? process.cwd());
  const tsconfigPath = resolve(cwd, options.tsconfigPath);
  let api: API;
  try {
    api = new API({
      cwd,
      fs: toTypeScriptFileSystem(options.fileSystem),
      collectTiming: options.collectTiming,
    });
  } catch (cause) {
    throw compilerStartError(tsconfigPath, cause);
  }
  try {
    return { api, project: openProject(api, tsconfigPath) };
  } catch (cause) {
    api.close();
    throw cause;
  }
}

/** Parses and opens one tsconfig on an already started compiler; the caller owns `api`. */
function openProject(api: API, tsconfigPath: string): Project {
  try {
    api.parseConfigFile(tsconfigPath);
  } catch (cause) {
    throw new ConfigError({
      tsconfigPath,
      message: `Could not read TypeScript configuration ${tsconfigPath}`,
      cause: safeCause(cause),
    });
  }
  let project: Project | undefined;
  try {
    project = api.createSnapshot({ openProjects: [tsconfigPath] }).getConfiguredProject(tsconfigPath);
  } catch (cause) {
    throw projectOpenError(tsconfigPath, cause);
  }
  if (project === undefined) {
    throw projectMissingError(tsconfigPath);
  }
  const diagnostics = project.program.getConfigFileParsingDiagnostics();
  if (diagnostics.length > 0) {
    const details = diagnostics
      .map((diagnostic) => `${diagnostic.fileName ?? tsconfigPath}: ${diagnostic.text}`)
      .join("; ");
    throw new ConfigError({
      tsconfigPath,
      message: `Invalid TypeScript configuration ${tsconfigPath}: ${details}`,
      cause: details,
    });
  }
  return project;
}

function normalizeTiming(info: ReturnType<API["getTimingInfo"]>): BackendTiming {
  return {
    enabled: info.enabled,
    totals: {
      requestCount: info.totals.requestCount,
      roundTripMs: info.totals.roundTripMs,
      bytesSent: info.totals.bytesSent,
      bytesReceived: info.totals.bytesReceived,
      serverTimeMs: info.totals.serverTimeMs,
      transportOverheadMs: info.totals.transportOverheadMs,
      nodesMaterialized: info.totals.nodesMaterialized,
      sourceFilesFetched: info.totals.sourceFilesFetched,
      nodesFetched: info.totals.nodesFetched,
    },
    recentRequests: info.recentRequests.map((request) => ({
      method: request.method,
      roundTripMs: request.roundTripMs,
      bytesSent: request.bytesSent,
      bytesReceived: request.bytesReceived,
      ...definedFields({
        serverTimeMs: request.serverTimeMs,
        transportOverheadMs: request.transportOverheadMs,
      }),
    })),
  };
}

class TsgoProject implements BackendProject {
  private closed = false;
  private readonly sessions = new Set<TsgoExtractionSession>();
  private readonly opened: OpenedProject;
  private readonly rootDirectory: string;
  private readonly projectRoot: string;
  private readonly provenanceRoot: string;
  private readonly cwd: string;
  private readonly pathIdentity: PathIdentity;
  private readonly timingEnabled: boolean;

  constructor(
    opened: OpenedProject,
    tsconfigPath: string,
    cwd: string,
    provenanceRoot: string,
    timingEnabled: boolean,
    realpath: ((path: string) => string | undefined) | undefined
  ) {
    this.opened = opened;
    this.projectRoot = dirname(tsconfigPath);
    this.provenanceRoot = provenanceRoot;
    this.rootDirectory = resolve(
      cwd,
      opened.project.program.getCompilerOptions().rootDir ?? dirname(tsconfigPath)
    );
    this.cwd = cwd;
    this.timingEnabled = timingEnabled;
    this.pathIdentity = createPathIdentity({
      platform: process.platform,
      provenanceRoot,
      virtualRealpath: realpath,
    });
  }

  openExtraction(options: BackendExtractionOptions = {}): TsgoExtractionSession {
    if (this.closed) {
      throw new BackendError({
        message: "Cannot open an extraction after the TypeScript project closed",
        cause: "The project scope has already been released.",
      });
    }
    const sessions = this.sessions;
    const session = new TsgoExtractionSession(
      this.opened.project,
      this.rootDirectory,
      this.projectRoot,
      this.provenanceRoot,
      this.cwd,
      this.pathIdentity,
      options.externalTypes ?? { kind: "none" },
      options.componentSources ?? false,
      (closedSession) => sessions.delete(closedSession)
    );
    this.sessions.add(session);
    return session;
  }

  getTimingInfo(): BackendTiming {
    if (!this.timingEnabled) return disabledTiming();
    try {
      return normalizeTiming(this.opened.api.getTimingInfo());
    } catch (cause) {
      throw new BackendError({
        message: "TypeScript compiler timing information could not be collected",
        cause: safeCause(cause),
      });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const session of this.sessions) session.close();
    this.sessions.clear();
    // api.close() also drops the project-scoped SourceFileCache, so shared
    // lib and dependency files are fetched once per project, not per session.
    this.opened.api.close();
  }
}

/**
 * Opens one TypeScript project for extraction.
 *
 * @param options - The tsconfig path, cwd, optional filesystem seam, and timing switch.
 * @returns A project that owns its compiler and every session opened from it.
 * @throws A `ConfigError` for unreadable or invalid tsconfig content, or a `BackendError`
 *   defect when the compiler cannot start or open the project.
 */
export function openTsgoProject(options: InternalOpenProjectOptions): BackendProject {
  const cwd = resolve(options.cwd ?? process.cwd());
  const tsconfigPath = resolve(cwd, options.tsconfigPath);
  return new TsgoProject(
    createApi(options),
    tsconfigPath,
    cwd,
    cwd,
    options.collectTiming === true,
    options.fileSystem?.realpath
  );
}
