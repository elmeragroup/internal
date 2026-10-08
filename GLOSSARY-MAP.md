# Glossary Map

## Contexts

- [Release](./packages/release/GLOSSARY.md): publishes `@elmeragroup/internal` from checked commits and
  records every publication for retry

API extraction, API artifacts and linting get their own glossaries when their first terms are
resolved.

## Relationships

- **Release ↔ Internal**: Internal ships Release as `@elmeragroup/internal/release` and supplies its
  own pack-and-verify adapter; Release owns everything after the archive bytes are returned.
