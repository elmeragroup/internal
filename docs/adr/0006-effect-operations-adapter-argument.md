# Callers see Effect operations and pass the adapter as an argument

`@elmeragroup/internal/release` exports three operations that return Effect. The pack-and-verify adapter is an argument, not a Layer the caller assembles. Git, GitHub, and npm use production defaults. Test replacements for those stay unpublished. Wiring Layers at the public seam would make every consumer reconstruct the internals.

**Considered options**: caller-wired Layers for git, store, registry, and adapter; Promise-only exports that hide Effect.
