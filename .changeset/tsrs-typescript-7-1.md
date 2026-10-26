---
"@elmeragroup/internal": minor
---

Run on [tsrs](https://github.com/oxc-project/tsrs), a Rust port of the TypeScript 7 compiler with TypeScript 7.1 semantics, instead of `typescript` 7.0.2. The package now depends on `tsrs` rather than `typescript`, and extraction uses the TypeScript 7.1 API. tsrs ships native binaries only for macOS arm64 and Linux x64/arm64 (glibc and musl), so `generateApiArtifacts` and the extractor now run only on those platforms; elsewhere they fail with a `BackendError` that names the missing binary. Generated artifacts are unchanged on the reference fixtures.
