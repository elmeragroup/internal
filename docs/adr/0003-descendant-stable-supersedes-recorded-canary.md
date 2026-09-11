# A descendant stable supersedes an ancestor canary

Comparing the highest stable version to a recorded canary's planned base alone lets `0.3.0-canary.0` from commit A be promoted to `canary` after descendant B has shipped `0.2.0` as `latest`. A published stable whose commit is a descendant of the recorded canary supersedes that canary even when the stable version is below the canary base. This ancestry check supplements the existing version checks.

If the canary is absent from npm, skip its upload and retain its reservation. If it already exists, including an upload under `pending`, retry must verify its archive integrity and source commit, skip upload and promotion, and may finish GitHub record finalization. A same-version identity mismatch remains fatal. Supersession never permits repacking or replacing the saved archive.

**Considered options**: keep version arithmetic only; let any published stable supersede every canary, including unrelated lines.
