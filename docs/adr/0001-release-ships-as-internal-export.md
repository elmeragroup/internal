# Release orchestration ships as an Internal export

Only `@elmeragroup/internal` is published, so the module is a private `packages/release` workspace bundled as `@elmeragroup/internal/release`. UI already depends on Internal. A second published package would give the publisher its own publisher.

**Consequences**: one published package per repository. Callers pass checkout root, package directory, and package name; the module must not derive the repo from its own path. Workflows stay in each repository.

**Considered options**: a second published package; a private package with no export; a reusable GitHub workflow that keeps TypeScript in `scripts/`; a list of packages; a `packages/<name>` path convention.
