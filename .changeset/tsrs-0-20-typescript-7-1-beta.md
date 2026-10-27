---
"@elmeragroup/internal": patch
---

Update the bundled compiler to tsrs 0.20.0, which ports the TypeScript 7.1 beta and imports its Node API from the stable `tsrs/*` subpaths instead of `tsrs/unstable/*`. macOS x64 is now supported alongside macOS arm64 and Linux x64/arm64 (glibc and musl). tsrs also ships a Windows x64 binary, but Windows is not supported: extraction path identity is not Windows-aware yet. Generated artifacts are unchanged on the reference fixtures.
