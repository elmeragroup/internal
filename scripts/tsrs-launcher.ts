import { Schema } from "effect";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

/** The part of the tsrs manifest that names its public command-line launcher. */
const TsrsManifest = Schema.Struct({ bin: Schema.Struct({ tsrs: Schema.String }) });

/**
 * Resolves the public tsrs launcher as a package depends on it.
 *
 * The launcher is the manifest's `bin.tsrs`; it selects the native binary for the platform
 * (honoring `TSRS_BINARY`) and runs either directly or through `process.execPath`. tsrs exports no
 * bin subpath, so the manifest is resolved and read instead.
 *
 * @param packageDirectory - The directory of the package whose `tsrs` dependency is used.
 * @returns The absolute launcher path.
 * @throws When the package cannot resolve `tsrs` or its manifest names no `tsrs` launcher.
 */
export function tsrsLauncherPath(packageDirectory: string): string {
  const manifestPath = createRequire(join(packageDirectory, "package.json")).resolve("tsrs/package.json");
  const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(TsrsManifest))(
    readFileSync(manifestPath, "utf8")
  );
  return resolve(dirname(manifestPath), manifest.bin.tsrs);
}
