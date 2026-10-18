---
title: Limits
description: What one in-memory client does not do.
---

This is one process, in memory. It is not a distributed cache.

- Browser timers can be throttled. Missed polls are not replayed. There is no background-service execution and no cross-tab leadership.
- The public build needs `AbortSignal.any` (Chrome 116, Firefox 124, Safari 17.4) and ES2023. Node 22+ provides both.
- There is no adaptive interval, reactive query parameters, or trailing refresh after a busy cycle.
- A non-cooperative `queryFn` can occupy a slot until its promise settles. Dispose does not cancel that promise.
- Payload bytes, write durability, and schema migration belong to the caller.
- No metrics server, HTTP server, framework bindings, or second execution engine is included.

Keys use a restricted JSON form. `keyId(key)` is the canonical string: finite JSON values, array order preserved, plain-object keys sorted. Cycles, `NaN`, and exotic objects throw. Two live queries on one client cannot share a canonical key. Dispose removes the key so it can be registered again.

Two clients do not share permits, keys, or cooldown. Disposing one does not dispose the other.
