---
"@elmeragroup/internal": patch
---

`generateApiArtifacts` no longer adds selected dependency props to a re-export-only facade; such parts keep `props: []` and their full `forwardedCount` even when the forwarding dependency (including the default `@base-ui/react`) is listed in `includeExternalTypes`.
