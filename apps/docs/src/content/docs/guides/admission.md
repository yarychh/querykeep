---
title: Admission
description: How one client shares concurrency, pacing, and cooldown across queries.
---

Admission is a coordinator owned by the client, not a rate-limit operator. Limits are per client, not across processes or tabs.

- Client-wide concurrency, optional provider concurrency, and one physical invocation per key.
- Eligibility-ordered FIFO. A ticket blocked by its provider or its own key does not block other providers.
- A ticket that can start now does not need a free queue slot when every queued ticket is ineligible. It does not jump a queued ticket that is already eligible. At the cap, that newcomer gets `AdmissionOverflowError`.
- `minIntervalMs` is the gap between actual starts, measured with the monotonic elapsed clock.
- `cooldown(provider, delayMs)` only extends that provider's not-before time. It never shortens it. You parse `Retry-After` yourself.
- The queue is finite. Abort, timeout, and close remove the ticket and do not leak a permit.

Unknown provider names throw when the query is created.

The attempt timeout starts when `queryFn` is called, not while the cycle is queued. Each invocation gets a new `AbortSignal` linked to pause, dispose, and `timeoutMs`. Unsubscribe aborts that signal but does not release the slot. The slot is released in the promise `finally`. The same key cannot start another invocation until that release. A later cycle waits in admission, under `admissionTimeoutMs`, instead of overlapping.

Admission queue overflow, admission timeout, and admission close set `error`, end the cycle, and do not count as source attempts. `shouldRetry` is not consulted for those errors.

A source that ignores abort and never settles can hold its client and provider slot indefinitely. Dispose does not cancel that promise. Later cycles for that key fail admission instead of overlapping the call.

`now` stamps `receivedAt` and defaults to `Date.now`. `elapsed` drives pacing and cooldown and defaults to `performance.now`. Do not persist monotonic values. Wall-clock changes do not by themselves release a cooldown that was recorded on the elapsed clock. `now`, `elapsed`, and `scheduler` are a test seam.
