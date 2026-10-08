# Release

Publishing one package from a checked main-branch commit to npm, and recording every publication so
a failed one can be finished later from the same archive.

## Language

### Intents and channels

**Release intent**:
The channel, version and source commit that one publication ships.
_Avoid_: release identity, release plan

**Channel**:
The release line a version belongs to: stable, installed as `latest`, or canary, installed as
`canary`.
_Avoid_: track, dist-tag

**Checked commit**:
The main-branch commit a publication run was started for.
_Avoid_: head

**Superseded canary**:
A canary whose channel already belongs to a newer release, so it is skipped and keeps its
reservation.

### Records

**Record**:
The durable GitHub draft release that holds one release intent and, once prepared, its recorded
archive.
_Avoid_: saved release, draft

**Incomplete record**:
A record whose recorded archive was never attached. Retry refuses it; the original Merge job must
run again.
_Avoid_: incomplete prepared record, starter record

**Prepared record**:
A record whose recorded archive is attached, so its release can be published.
_Avoid_: saved release, recorded release, verified record

**Completed record**:
A prepared record whose release reached npm, published as a GitHub release.
_Avoid_: finished record, finalized record, finalization

**Record tag**:
The lookup key of a record: `v<version>` for a stable intent, `canary-<commit>` for a canary.

**Recorded archive**:
The verified package archive attached to a record, and the only bytes ever published for its
intent.
_Avoid_: asset, tarball, release.tgz

**Reservation**:
A canary version held by a record, published or not, so no other commit can claim it.

**Record store**:
The single owner of the record lifecycle: reserving a record, attaching or restoring its recorded
archive, and completing the record after publication.
_Avoid_: GitHub store, release store

### Packing

**Pack-and-verify adapter**:
The consumer-supplied step that stamps packed identity, builds, packs and checks the package, and
returns the archive bytes.

**Packed identity**:
The source commit and channel stamped into the packed manifest, tying an archive to its intent.
