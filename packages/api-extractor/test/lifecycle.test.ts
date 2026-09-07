import childProcess from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

const nativeChildren: ChildProcess[] = [];
const originalSpawn = childProcess.spawn;

// SAFETY: the wrapper preserves the original overloaded spawn function and only records children
// whose arguments contain the TypeScript API marker.
childProcess.spawn = ((...args: Parameters<typeof originalSpawn>) => {
  const child = originalSpawn(...args);
  const spawnArguments = args[1];
  if (Array.isArray(spawnArguments) && spawnArguments.includes("--api")) {
    nativeChildren.push(child);
  }
  return child;
}) as typeof originalSpawn;
syncBuiltinESMExports();

const { Effect, Layer, Schema } = await import("effect");
const { ConfigError, ProjectExtractor } = await import("../src/index.ts");
const { openTsgoProject } = await import("../src/backend/ts7/project.ts");
const { CompilerBackend } = await import("../src/backend/service.ts");
const { projectExtractorLayer } = await import("../src/extractor.ts");

const fixtureDirectory = resolve(import.meta.dirname, "fixtures/basic");
const tsconfigPath = resolve(fixtureDirectory, "tsconfig.json");
const inputPath = resolve(fixtureDirectory, "input.ts");
const missingPath = resolve(fixtureDirectory, "missing.ts");
const invalidTsconfigPath = resolve(fixtureDirectory, "invalid-tsconfig.json");

afterAll(() => {
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
});

function nativeChildSince(startIndex: number): ChildProcess {
  const child = nativeChildren.slice(startIndex).find((candidate) => candidate.pid !== undefined);
  if (child?.pid === undefined) {
    throw new Error("The TypeScript native compiler child was not observed");
  }
  return child;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // SAFETY: process.kill reports an ESRCH ErrnoException when the observed PID has exited.
    if ((cause as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw cause;
  }
}

function nativeChildPid(child: ChildProcess): number {
  if (child.pid === undefined) {
    throw new Error("The TypeScript native compiler child did not expose a PID");
  }
  return child.pid;
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  return new Promise((resolveExit, rejectExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit();
      return;
    }
    const onExit = () => {
      child.removeListener("error", onError);
      resolveExit();
    };
    const onError = (error: Error) => {
      child.removeListener("exit", onExit);
      rejectExit(error);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function waitForProcessExit(child: ChildProcess): Promise<void> {
  const pid = nativeChildPid(child);
  await waitForChildExit(child);
  const deadline = Date.now() + 5_000;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`The TypeScript native compiler process ${pid} is still alive`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

describe("ProjectExtractor native compiler lifecycle", () => {
  it("exits within five seconds after live project acquisition rejects an invalid configuration", async () => {
    const packageEntry = pathToFileURL(resolve(import.meta.dirname, "../src/index.ts")).href;
    const childScript = `
      import { Cause, Effect, Option } from "effect";
      import { ProjectExtractor } from ${JSON.stringify(packageEntry)};

      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            yield* ProjectExtractor;
            return "unexpected-success";
          }).pipe(
            Effect.provide(ProjectExtractor.live({
              tsconfigPath: ${JSON.stringify(invalidTsconfigPath)}
            }))
          )
        )
      );
      if (exit._tag === "Success") {
        process.stderr.write("Project acquisition unexpectedly succeeded");
        process.exitCode = 2;
      } else {
        const error = Cause.findErrorOption(exit.cause);
        if (Option.isNone(error)) {
          process.stderr.write("Project acquisition failed without a typed error");
          process.exitCode = 3;
        } else {
          process.stdout.write(JSON.stringify(error.value));
        }
      }
    `;

    const child = childProcess.spawn(process.execPath, ["--input-type=module", "--eval", childScript], {
      cwd: resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const status = await new Promise<number | null>((resolveStatus, rejectStatus) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        rejectStatus(
          new Error(`Live project acquisition did not release its process within five seconds: ${stderr}`)
        );
      }, 5_000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        rejectStatus(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        resolveStatus(code);
      });
    });

    expect(status, stderr).toBe(0);
    const failure = Schema.decodeUnknownSync(ConfigError)(JSON.parse(stdout));
    expect(failure._tag).toBe("ConfigError");
    expect(failure.tsconfigPath).toBe(invalidTsconfigPath);
    expect(failure.message).toContain(invalidTsconfigPath);
  });

  it("unregisters closed sessions while retaining active project cleanup", () => {
    const project = openTsgoProject({ tsconfigPath });
    const closedSessionSpies = [];
    try {
      for (let index = 0; index < 100; index += 1) {
        const session = project.openExtraction();
        const closeSpy = vi.spyOn(session, "close");
        session.close();
        closedSessionSpies.push(closeSpy);
      }

      const activeSession = project.openExtraction();
      const activeCloseSpy = vi.spyOn(activeSession, "close");
      project.close();
      project.close();

      expect(closedSessionSpies.every((spy) => spy.mock.calls.length === 1)).toBe(true);
      expect(activeCloseSpy).toHaveBeenCalledTimes(1);
    } finally {
      project.close();
    }
  });

  it("closes the compiler child after successful extraction when the Scope ends", async () => {
    const startIndex = nativeChildren.length;
    const { child, result } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const extractor = yield* ProjectExtractor;
          const child = yield* Effect.sync(() => nativeChildSince(startIndex));
          const result = yield* extractor.extractModule(inputPath);
          return { child, result };
        }).pipe(Effect.provide(ProjectExtractor.live({ tsconfigPath })))
      )
    );

    expect(result.module.name).toBe("input");
    await waitForProcessExit(child);
    expect(isProcessAlive(nativeChildPid(child))).toBe(false);
  });

  it("closes the compiler child after failed extraction when the Scope ends", async () => {
    const startIndex = nativeChildren.length;
    const { child, exit } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const extractor = yield* ProjectExtractor;
          const child = yield* Effect.sync(() => nativeChildSince(startIndex));
          const exit = yield* Effect.exit(extractor.extractModule(missingPath));
          return { child, exit };
        }).pipe(Effect.provide(ProjectExtractor.live({ tsconfigPath })))
      )
    );

    expect(exit._tag).toBe("Failure");
    await waitForProcessExit(child);
    expect(isProcessAlive(nativeChildPid(child))).toBe(false);
  });

  it("inspects component sources, unresolved results, and repeated calls on one project", async () => {
    const startIndex = nativeChildren.length;
    const sourceModes: (boolean | undefined)[] = [];
    const backend = Layer.succeed(CompilerBackend, {
      openProject: (options) =>
        Effect.gen(function* () {
          const project = yield* Effect.acquireRelease(
            Effect.sync(() => openTsgoProject(options)),
            (opened) => Effect.sync(() => opened.close())
          );
          return {
            openExtraction: (sessionOptions) => {
              sourceModes.push(sessionOptions?.componentSources);
              return project.openExtraction(sessionOptions);
            },
            close: () => project.close(),
          };
        }),
    });
    const { child, resolved, unresolved, repeated, extracted } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const extractor = yield* ProjectExtractor;
          const child = yield* Effect.sync(() => nativeChildSince(startIndex));
          const resolved = yield* extractor.inspectComponentSources(inputPath, [{ exportName: "greet" }]);
          const unresolved = yield* extractor.inspectComponentSources(inputPath, [{ exportName: "missing" }]);
          const repeated = yield* extractor.inspectComponentSources(inputPath, [
            { exportName: "greet" },
            { exportName: "greet" },
          ]);
          const extracted = yield* extractor.extractModule(inputPath);
          return { child, resolved, unresolved, repeated, extracted };
        }).pipe(Effect.provide(projectExtractorLayer({ tsconfigPath }).pipe(Layer.provide(backend))))
      )
    );

    expect(resolved).toEqual([{ status: "resolved", filePath: inputPath, defaults: [] }]);
    expect(unresolved).toEqual([{ status: "unresolved", reason: "export-not-found" }]);
    expect(repeated).toEqual([resolved[0], resolved[0]]);
    expect(extracted.module.exports.map((entry) => entry.name)).toEqual(["greet"]);
    expect(sourceModes).toEqual([true, true, true, undefined]);
    await waitForProcessExit(child);
    expect(isProcessAlive(nativeChildPid(child))).toBe(false);
  });

  it("closes the compiler child after a thrown source inspection failure", async () => {
    const startIndex = nativeChildren.length;
    const { child, exit } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const extractor = yield* ProjectExtractor;
          const child = yield* Effect.sync(() => nativeChildSince(startIndex));
          const exit = yield* Effect.exit(
            extractor.inspectComponentSources(missingPath, [{ exportName: "greet" }])
          );
          return { child, exit };
        }).pipe(Effect.provide(ProjectExtractor.live({ tsconfigPath })))
      )
    );

    expect(exit._tag).toBe("Failure");
    await waitForProcessExit(child);
    expect(isProcessAlive(nativeChildPid(child))).toBe(false);
  });
});
