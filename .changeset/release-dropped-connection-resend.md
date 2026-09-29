---
"@elmeragroup/internal": patch
---

Publishing no longer fails with `fetch failed` (`UND_ERR_SOCKET: other side closed` or `EPIPE`) on the first GitHub or npm registry request after a long pack. GitHub drops idle keep-alive connections within a minute, and a synchronous pack adapter or `npm publish` blocks the event loop, so the next request reused a closed socket. A GET, HEAD, PUT, DELETE or PATCH that fails on a dropped connection is now sent once more on a fresh connection. POST writes are still never resent.
