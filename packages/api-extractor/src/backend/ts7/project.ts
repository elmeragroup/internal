import { dirname, resolve } from "node:path";
import { API } from "typescript/unstable/sync";
import type { Project } from "typescript/unstable/sync";

import { BackendError, ConfigError, safeCause } from "../../errors.ts";
import type { InternalOpenProjectOptions } from "../../internal/project-options.ts";
import { definedFields } from "../../optional-fields.ts";
import type { ProjectFileSystem } from "../../options.ts";
import type { BackendExtractionOptions, BackendProject, BackendTiming } from "../contracts.ts";
import { disabledTiming } from "../contracts.ts";
import { createPathIdentity } from "./path-identity.ts";
import type { PathIdentity } from "./path-identity.ts";
import { TsgoExtractionSession } from "./session.ts";

type OpenedProject = { readonly api: API; readonly project: Project };

function toTypeScriptFileSystem(fileSystem: ProjectFileSystem | undefined) {
  if (fileSystem === undefined) return undefined;
  return {
    directoryExists: fileSystem.directoryExists,
    fileExists: fileSystem.fileExists,
    getAccessibleEntries: (directoryName: string) => {
      const entries = fileSystem.getAccessibleEntries?.(directoryName);
      return entries === undefined
        ? undefined
        : { files: [...entries.files], directories: [...entries.directories] };
    },
    readFile: fileSystem.readFile,
    realpath: fileSystem.realpath,
    writeFile: fileSystem.writeFile,
    removeFile: fileSystem.removeFile,
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
    throw new BackendError({
      message: `Could not start TypeScript compiler for ${tsconfigPath}`,
      cause: safeCause(cause),
      filePath: tsconfigPath,
    });
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
    project = api.updateSnapshot({ openProjects: [tsconfigPath] }).getProject(tsconfigPath);
  } catch (cause) {
    throw new BackendError({
      message: `Could not open TypeScript project ${tsconfigPath}`,
      cause: safeCause(cause),
      filePath: tsconfigPath,
    });
  }
  if (project === undefined) {
    throw new BackendError({
      message: `TypeScript did not open project ${tsconfigPath}`,
      cause: tsconfigPath,
      filePath: tsconfigPath,
    });
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
