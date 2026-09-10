# Release

Private workspace for publication identity, configuration, versioning, and policy. It is not
published; `@elmeragroup/internal` remains the only npm package. Requires Node >=24.13.0 <25.

Callers pass checkout root, package directory, and package name. The module does not derive the
repository from its own path. `resolveReleasePackage` resolves both directories, requires the package
directory to be the checkout root or a path inside it, and checks that `package.json` exists and that
its `name` matches.

New GitHub record bodies include `"owner": "elmera-release"`. Ownership is recognized before intent
validation. An owned record with an invalid payload, unsupported schema, or mismatched tag is an
error; reservation discovery must not skip it. Unmarked `schema: 1` intents remain readable without
rewrite. Tags that are not record tags are ignored during discovery. A foreign occupant of a record
tag fails without mutation.

A published stable whose commit is a descendant of a recorded canary supersedes that canary even
when the stable version is below the canary's planned base. Same-version identity mismatches stay
fatal. Fresh canary eligibility still uses version comparison; descendant-stable applies to a
recorded canary's publication plan.
