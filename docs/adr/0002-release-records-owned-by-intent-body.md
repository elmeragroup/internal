# Record ownership is recognized before intent validation

Tags `v<stable>` and `canary-<sha>` are lookup keys. New record bodies carry an explicit owner marker that stays stable across intent schema versions. Recognize ownership before validating the intent: an owned record with an invalid payload, unsupported schema, or mismatched tag is fatal. It must not disappear from reservation history because decoding failed.

Existing unmarked `schema: 1` intent bodies remain supported without rewriting them. Bodies containing the legacy schema and release-intent fields, or releases carrying `release.tgz`, require strict legacy validation; malformed candidates are errors, not foreign releases. Skip only clearly foreign releases during discovery. If a foreign tag or release occupies the exact requested record tag, fail without modifying it.

**Considered options**: fail closed on a matching tag with a non-intent body; a separate tag namespace for machine records.
