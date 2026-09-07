---
"@elmeragroup/internal": minor
---

Publish artifact generation, low-level extraction, and both Oxlint plugins through explicit entry points in one package. Bundle private workspace implementations and declarations while keeping compiler, Effect, and Oxlint runtime dependencies external. Artifact generation loads on invocation so error-only consumers can discard the generator and compiler code.
