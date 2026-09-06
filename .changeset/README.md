# Changesets

Run `pnpm changeset` for changes to published packages. For documentation, CI, or test-only pull requests, use the `no-changeset` GitHub label.

The three public packages are a fixed group: a changeset for any of them versions all three together.
Merging to `main` opens a Version Packages pull request, which still runs full package and consumer
verification. Canary releases use the separate Publish Canary workflow described in the root README.
There is no stable npm publication path.
