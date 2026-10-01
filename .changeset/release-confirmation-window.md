---
"@elmeragroup/internal": patch
---

Publishing no longer fails with `Publication could not be verified; retry the recorded release` while npm is still processing a newly uploaded version. Registry confirmation used to give up after ten reads, about four minutes, and npm's asynchronous processing has taken longer than that. Upload and dist-tag confirmation now each keep checking for ten minutes. The delay between reads still starts at five seconds, doubles, and is capped at 30 seconds. A version or dist-tag that never appears still fails with the same retry messages.
