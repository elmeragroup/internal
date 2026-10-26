# Changesets

[CONTRIBUTING.md](../CONTRIBUTING.md#release-impact) says when a pull request needs a changeset
and when it carries the `no-changeset` label instead.

Successful main checks create or update the Version Packages PR. Its generated branch receives
explicitly dispatched checks. Review it and merge when you want to ship stable; its exact main commit
is checked and published. Keep the PR current with main so it consumes all pending changesets.

Ordinary successful main commits publish canaries automatically. Their base comes from the pending
Changesets plan, and their numeric suffix comes from npm history and reserved releases. Canary
publication never consumes changesets or commits a canary version. See the root README for setup
and recovery using recorded archives.
