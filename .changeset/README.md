# Changesets

Run `pnpm changeset` for changes to published packages. For documentation, CI, or test-only pull requests, use the `no-changeset` GitHub label.

Only `@elmeragroup/internal` is published. Changes to its private extractor, artifact, or lint
implementations receive a changeset for `@elmeragroup/internal` when they affect consumers.

Successful main checks create or update the Version Packages PR. Its generated branch receives
explicitly dispatched checks. Review it and merge when you want to ship stable; its exact main commit
is checked and published. Keep the PR current with main so it consumes all pending changesets.

Ordinary successful main commits publish canaries automatically. Their base comes from the pending
Changesets plan, and their numeric suffix comes from npm history and reserved releases. Canary
publication never consumes changesets or commits a canary version. See the root README for setup
and recovery using recorded archives.
