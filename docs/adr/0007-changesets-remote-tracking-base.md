# Changesets must plan against a remote-tracking base branch

A release checkout is detached at the checked commit. `baseBranch: main` plans against a local name that may be missing or stale. The module requires `origin/<branch>`, as Internal already does. UI must change `.changeset/config.json` from `main` to `origin/main` before it can adopt.

**Considered options**: pass a git ref on every call; honor `.changeset/config.json` even when it names a local branch.
