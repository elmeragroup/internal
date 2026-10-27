import { Schema } from "effect";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { typescriptVersion, version } from "tsrs";

/** The compiler identity that evidence records: the tsrs package and the TypeScript it ports. */
export type CompilerIdentity = {
  /** The installed compiler package, such as `tsrs@0.20.0-ts7.1.0-beta`. */
  readonly compiler: string;
  /** The microsoft/TypeScript version that compiler ports, such as `7.1.0-beta`. */
  readonly typescript: string;
};

/** Reads the identity of the installed tsrs compiler from its package metadata. */
export function compilerIdentity(): CompilerIdentity {
  return { compiler: `tsrs@${version}`, typescript: typescriptVersion };
}

/** The part of the tsrs manifest that names its public command-line launcher. */
const TsrsManifest = Schema.Struct({ bin: Schema.Struct({ tsrs: Schema.String }) });

/**
 * The tsrs command-line launcher that evidence scripts run with `process.execPath`.
 *
 * This is the manifest's `bin.tsrs`, resolved the way the workspace's `scripts/tsrs-launcher.ts`
 * does. The rule is repeated here because this package's scripts must run from a relocated copy of
 * the package alone, without the workspace's root scripts.
 */
export function compilerScriptPath(): string {
  const manifestPath = createRequire(import.meta.url).resolve("tsrs/package.json");
  const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(TsrsManifest))(
    readFileSync(manifestPath, "utf8")
  );
  return resolve(dirname(manifestPath), manifest.bin.tsrs);
}
