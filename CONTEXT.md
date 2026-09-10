# Package release

Publication of one npm package from a main-branch commit, with durable identity so a failed run can finish the same artifact.

## Language

**Channel**:
The release line a commit is on: canary or stable.
_Avoid_: pending, latest, beta, dist-tag

**Dist-tag**:
An npm tag that points at a published version. Installable tags are `canary` and `latest`. `pending` is staging only and is not an install line.
_Avoid_: channel

**Intent**:
The identity of a release: its channel, version, and source commit.

**Record**:
An owned release's durable saved intent and any verified bundle. An incomplete record still preserves the intent and reservation. Ownership is distinct from intent validity; an invalid owned record is an error, not a foreign release.
_Avoid_: GitHub release, npm version

**Record tag**:
The lookup key for a record. Stable records use `v` plus the version. Canary records use `canary-` plus the full source commit.

**Reservation**:
A record that occupies a canary version so a later commit cannot reuse that number, even when npm does not have it yet.

**Checked commit**:
The exact main-branch commit that already passed the repository's merge checks. Publication must use this commit, not a later tip.

**Source commit**:
The commit stamped into the packed package. It must match the intent.

**Planned base**:
The next stable version Changesets would cut. Canary versions are numbered from this prefix. Planning reads Changesets against a remote-tracking base branch (`origin/<branch>`), not a local branch name, so a detached checkout still plans the same commit.

**Archive**:
The package tarball that npm will receive.
_Avoid_: bundle, the on-disk artifacts directory

**Receipt**:
Proof that this repository's packed-consumer checks passed against that exact archive. Repacking invalidates it.

**Bundle**:
The archive, the archive report, and the receipt, bound together as the bytes stored on a record.

**Verified release**:
An intent plus the archive's integrity.

**Retry**:
Finish a prepared record from its saved bundle. It does not pack again. The checkout tip may have moved. An incomplete record (no uploaded bundle) is not a retry; that commit's original prepare must be rerun.

**Superseded**:
A canary that must not be promoted. A later published canary on a descendant commit supersedes it. A published stable whose commit is a descendant of the recorded canary also supersedes it, even when that stable version is below the canary's planned base.

**Release PR**:
The single Version Packages pull request whose merge commit is the stable release.

**Publication lock**:
Publication is serial and does not cancel a run already in the queue. Arrival order is not commit order, so commit-order checks still apply.

**Package**:
The single published npm package this flow releases. The module does not release a workspace of several packages.
_Avoid_: workspace, repository

**Packed identity**:
The packed archive carries the package name, version, source commit, and channel. Writing those fields only in the source tree is not enough. Source commit and channel live in the packed `elmeraRelease` field.
