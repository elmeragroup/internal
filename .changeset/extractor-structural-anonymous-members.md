---
"@elmeragroup/internal": patch
---

The extractor now describes anonymous objects wherever they are structure rather than the export's own value: inferred container elements, type arguments, and members of an inferred root-level union no longer degrade to `any` with an `unsupported-type-fallback` warning, and a hole in a partially instantiated alias keeps every later argument bound to its own parameter. An enum merged with a namespace now keeps its value descriptor when the namespace is declared first. The reviewed boundary timing evidence was refreshed because removing a dead heritage probe materializes 13 fewer compiler nodes for the base-ui fixture, so its fetched-to-materialized ceiling moved from 140 to 145 while request and byte counts are unchanged.
