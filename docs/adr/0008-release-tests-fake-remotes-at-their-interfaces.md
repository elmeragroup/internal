# Release tests fake GitHub and npm at their own interfaces

Release tests drive the three operations through the internal `createReleaseOperations` constructor.
GitHub and the npm registry are faked at their HTTP interface and the npm CLI through an injected
runner; the checkout is a real temporary git repository. There is no in-memory Record store and no
port-level test seam. The usual advice is to fake your own adapter and test that adapter against the
real service, but these tests cannot reach GitHub, so the GitHub adapter needs a fake GitHub anyway.
A second, in-memory store fake drifted from the real store: it enforced none of its ordering rules.

**Consequences**: one fake remote models documented GitHub behaviour (drafts in listings, paginated
listings, an empty `starter` asset after a failed upload, 422 on a duplicate asset name) and is the
only fake of a remote. Confirmation timing stays live; the fake registry is consistent, so the first
read confirms. Tests survive internal changes to the engine, the Record store and publication. Each
operation test builds a git checkout, which costs about a quarter of a second.

**Considered options**: an in-memory Record store checked by a contract suite against the GitHub
adapter; keeping the engine's port bag as a fast test seam for checkout-side ports; faking npm with
a script on `PATH`, which runs in another process and cannot update an in-memory registry.
