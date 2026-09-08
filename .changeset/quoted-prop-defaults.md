---
"@elmeragroup/internal": patch
---

`generateApiArtifacts` and the extractor's `inspectComponentSources` now preserve destructuring defaults authored under string-literal or numeric-literal property keys, such as `{ "aria-label": label = "hello" }`. The default is reported under the decoded property name (`aria-label`), so generated `defaultValue` fields and extraction provenance no longer omit it. Computed keys are still omitted rather than guessed.
