---
"@elmeragroup/internal": patch
---

`generateApiArtifacts` now lists props declared in TypeScript's default library, such as the members of `Intl.NumberFormatOptions`, as `forwardedFrom: ["typescript"]`. It previously named the per-platform package TypeScript 7 installs the library in, such as `@typescript/typescript-darwin-arm64`, so an artifact committed from one platform failed the drift check on another.
