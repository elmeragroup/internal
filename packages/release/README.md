# Release

Private workspace for publication identity, configuration, versioning, policy, and Effect
operations. It is not published; `@elmeragroup/internal` remains the only npm package. Consumers
import the operations from `@elmeragroup/internal/release`. Requires Node >=24.13.0 <25.

Callers pass checkout root, package directory, and package name. The module does not derive the
repository from its own path. `resolveReleasePackage` resolves both directories, requires the package
directory to be the checkout root or a path inside it, and checks that `package.json` exists and that
its `name` matches.

## Operations

The engine exports three Effect operations. Importing this module does not publish, mutate the
filesystem, or read credentials. GitHub token and repository are validated when an operation that
needs them runs, not at import time. `resolveReleasePackage` may read `package.json` when called; the
engine module does not call it at top level.

```ts
checkReleasePr(pkg: ReleasePackage): Effect<void, ReleaseError>
releaseCheckedCommit(pkg: ReleasePackage, adapter: PackAndVerify, commit: string): Effect<void, ReleaseError>
retryRelease(pkg: ReleasePackage, recordTag: string): Effect<void, ReleaseError>
```

- `checkReleasePr` asserts a stable version bump against the remote-tracking base
  (`origin/<branch>` from `.changeset/config.json`) and the checked-out changelog and changesets.
- `releaseCheckedCommit` publishes the checked main-branch commit. Pack-and-verify is an argument,
  used only on this path. Git, GitHub, npm, and Changesets adapters are production defaults inside
  the engine.
- `retryRelease` finishes a prepared record from its saved bundle bytes. It does not pack. A missing
  or incomplete bundle keeps the current error: rerun the original Merge job.

Callers do not assemble production Layers for git, store, registry, or changesets.

## Pack-and-verify adapter

```ts
type PackAndVerify = {
  pack: (intent: ReleaseIntent) => Uint8Array;
};
```

The consumer stamps packed identity, builds, packs, verifies, and returns the durable bundle bytes.
The engine uploads those bytes and restores them on retry. The shared engine does not hardcode
`pnpm packages:pack` or Internal archive names.

`pack` may return a path's bytes; those bytes must remain valid until the engine copies them into
the GitHub upload. Returning a `Uint8Array` is the supported contract.

## Errors

Expected failures are `ReleaseError` (`Schema.TaggedError`, `_tag: "ReleaseError"`, `message`, and
optional `cause`). Integrity and source mismatches are fatal: they are never retried as transient
and never accepted as success. Upload-then-reported-failure is reconciled from npm identity after
the publish command. If that identity never appears, `cause` keeps the original npm error.

## Tool prerequisites

Needed when operations run, not at import:

- `git`
- `npm` (publish and dist-tag updates)
- `@changesets/cli` in the **consuming checkout** (`pkg.checkoutRoot`), never from this package's
  location. Planning uses `status --output` with a relative plan file and does not pass `--since`.
  The base branch must already be the remote-tracking name in `.changeset/config.json`
  (`origin/main` for Internal).
- GitHub repository and token (`GITHUB_REPOSITORY`, `GH_TOKEN`) for publication and retry. Not
  required for `checkReleasePr`.

## Recovery and cleanup

Scratch directories used to unpack a restored bundle are acquired with Effect `Scope` /
`acquireRelease` and removed when the operation finishes or fails. **Process kill is not covered**
by scoped cleanup; a killed process can leave temp directories and, for a consumer pack adapter that
rewrites the working tree, rewritten manifests.

Retry restores the saved bundle bytes and verifies those exact bytes. If preparation never uploaded
the bundle, retry refuses and the original Merge job must be rerun.

New GitHub record bodies include `"owner": "elmera-release"`. Ownership is recognized before intent
validation. An owned record with an invalid payload, unsupported schema, or mismatched tag is an
error; reservation discovery must not skip it. Unmarked `schema: 1` intents remain readable without
rewrite. Tags that are not record tags are ignored during discovery. A foreign occupant of a record
tag fails without mutation.

A published stable whose commit is a descendant of a recorded canary supersedes that canary even
when the stable version is below the canary's planned base. Same-version identity mismatches stay
fatal. Fresh canary eligibility still uses version comparison; descendant-stable applies to a
recorded canary's publication plan.
