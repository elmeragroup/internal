import { Effect } from "effect";

import { checkReleasePr } from "../packages/release/src/index.ts";
import { releasePackage } from "./release.ts";

await Effect.runPromise(checkReleasePr(releasePackage));
