---
"@elmeragroup/internal": patch
---

Update the bundled compiler to tsrs 0.25.0 (`0.25.0-ts7.1.0-beta`). It still ports the TypeScript 7.1 beta from the same TypeScript source, and it fixes a parser panic on some JSDoc comments and memory growth across repeated program rebuilds. Supported platforms are unchanged: macOS arm64/x64 and Linux x64/arm64 (glibc and musl). Generated artifacts are unchanged on the reference fixtures.
