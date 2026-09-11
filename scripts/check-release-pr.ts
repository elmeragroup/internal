import { Effect } from "effect";

import { checkReleasePr } from "@elmeragroup/release";

import { releasePackage } from "./release.ts";

await Effect.runPromise(checkReleasePr(releasePackage));
