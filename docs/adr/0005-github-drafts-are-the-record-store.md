# GitHub draft releases are the record store

Extracting Internal's flow keeps draft GitHub releases as the durable store: immutable uploaded bundle, tag pinned to the source commit, intent in the body. A second store would be a second adapter, and there is no second production store. npm is the registry, not the reservation log.
