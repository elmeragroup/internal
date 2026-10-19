---
"@elmeragroup/internal": patch
---

The `oxlint` plugin's `no-rac-outside-quarantine` rule now treats `packages/fuse/src/react-aria/**` as the React Aria quarantine, so imports, re-exports, and literal dynamic imports there are allowed without a rule override. The former `packages/ui/src/react-aria/**` root is no longer the quarantine. The descriptions and messages of `no-rac-outside-quarantine`, `no-internal-dynamic-import`, `no-local-focus-ring`, `restrict-browser-helper-copy`, and `restrict-package-root-from-script` now name `packages/fuse` paths.
