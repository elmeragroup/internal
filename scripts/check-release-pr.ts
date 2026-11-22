import * as Effect from "effect/Effect";

import { checkReleasePr } from "@elmeragroup/release";

import { releaseLayout } from "./release.ts";

await Effect.runPromise(checkReleasePr(releaseLayout()));
