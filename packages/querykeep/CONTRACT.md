# Querykeep contract

Normative behavior for the public alpha. The package README is the user-facing wording of the same rules. Research notes and the pre-replacement comparison stay off this repository.

The package name is `querykeep`. It is private. No license is chosen here. Publication is a separate decision.

## In scope

- `createQueryClient` and `createQuery`, plain options, subscribed streams.
- `Query.key`, `client.get`, `state()`, and `refresh()` returning whether the trigger was delivered.
- `triggerSkipped` carries `busy` or `cannotRun`.
- Start on create. Pause, resume, per-query dispose, and client dispose.
- Immediate first cycle, then `intervalMs`, or one run when `intervalMs` is false.
- `exhaustMap` skipping, bounded retries, functional delay, optional `shouldRetry`, last-success retention.
- Client and provider concurrency, per-key exclusion, start spacing, cooldown, and a finite queue.
- Separate admission and attempt timeouts. Admission failures are not source attempts.
- Optional `refreshOn$`, `enabled$`, shared `select`, and non-replaying `events$`.
- Node 22+, Bun, and browser types without Node types on the public build.

## Out of scope

Freshness helpers, fetch-on-read, subscriber-controlled polling, server endpoints, mutations, framework hooks, push streams, dependency graphs, cross-tab leadership, durable jobs, history, adaptive schedules, reactive parameters, a trailing refresh after a busy cycle, token buckets, circuit breakers, a storage port, and a second execution engine.

## Rules

- One client is one registry, one admission coordinator, and one set of defaults. Two clients share nothing.
- `keyId` is canonical JSON. One live query per key. Dispose frees the key. Payloads are not cloned.
- `enabled: false` starts paused. A synchronous first `enabled$` value applies before the initial run. A synchronous value already present on `refreshOn$` is not a refresh.
- Busy triggers and triggers while `!canRun` are dropped. Missed ticks are not replayed.
- `client.dispose()` closes admission, then disposes every query. A queued wait records `AdmissionClosedError` and does not consult `shouldRetry`. An in-flight attempt keeps the existing error. A later `query()` throws.
- A ready admission ticket does not take a queue slot when every queued ticket is ineligible. It does not jump a queued ticket that is already ready.
- `receivedAt` follows `now`. Pacing and cooldown follow `elapsed`. `Date` and `Map` payloads keep their references.
- Control methods called from a `state$` subscriber run after that notification. `refresh()` from that subscriber returns `false`; the deferred call still runs.
- `refresh()` returns `true` only when it delivers a trigger. Disposed, paused, blocked, not executing, or already in a cycle returns `false`.
- `client.get` returns the live query or `undefined`. Its type argument is not checked. `query()` still throws on a duplicate key.
- `Query.key` is the canonical id. Standalone `createQuery` uses the key `query` on a private admission object.

## Acceptance scenarios

| ID  | Scenario                                                   | Pass condition                                                                                 |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A01 | `state()` before the source settles                        | The query has started. `state()` does not fetch                                                |
| A02 | Many readers, then zero                                    | One execution. Unsubscribe does not change the call count                                      |
| A03 | Same key, reordered object properties                      | Same `keyId`. The second live query throws. Dispose allows the key again                       |
| A04 | `initialSnapshot`, then a success                          | The original `receivedAt` is replayed first. The success replaces it                           |
| A05 | `intervalMs: false`                                        | One immediate call. Later time does not call again. `refresh()` does                           |
| A06 | Retries exhaust, then a later tick succeeds                | The snapshot stays through the failure. Observation stays open                                 |
| A07 | Several keys share provider limits                         | A blocked provider does not block another                                                      |
| A08 | Caller parses `Retry-After` and calls `cooldown`           | The provider not-before only extends. Another provider can still start                         |
| A09 | Admission wait is longer than the attempt timeout          | `queryFn` is not called until granted, and then it has its own timeout                         |
| A10 | Queue full or admission timeout                            | Distinct admission error. `shouldRetry` is not consulted. Source calls do not increase         |
| A11 | Pause, dispose, or timeout while the promise ignores abort | Late data is ignored. The slot stays until settlement. The next cycle does not overlap the key |
| A12 | `refreshOn$` skip, drop, completion, and error             | Busy and `!canRun` emissions do not queue. Completion and errors do not stop polling           |
| A13 | `enabled$` starts false, then true                         | A synchronous `false` blocks startup. `true` does not clear `pause()`                          |
| A14 | `select` of missing data                                   | `undefined` is delivered. Two subscribers share one projection. A new `select()` is a new view |
| A15 | `events$` subscribed after a success                       | No replay. Later events arrive. Dispose completes the stream                                   |
| A16 | Dispose, pause, or refresh from a `state$` subscriber      | The stream is not completed mid-notification                                                   |
| A17 | Equal payload, newer success                               | `receivedAt` changes. `snapshots$` emits                                                       |
| A18 | Elapsed clock and scheduler are injected                   | Pacing and cooldown follow `elapsed`. Timestamps follow `now`                                  |
| A19 | Pause across several interval periods                      | Missed ticks are not replayed. Resume runs once immediately                                    |
| A20 | Client dispose during a fetch                              | The previous error stays. A later `query()` throws                                             |
| A21 | Browser typecheck and bundle                               | Declarations typecheck with DOM + ES2023 and `"types": []`                                     |
| A22 | Two clients                                                | Separate registries and admission                                                              |
| A23 | Standalone `createQuery`                                   | Same cycle without a registry                                                                  |
| A24 | Native payload values                                      | `Date` and `Map` stay the same references. The library does not JSON-encode the payload        |

A full queue of ineligible tickets must still admit a ticket that can start now. A queued ticket that has become eligible keeps its place when the cap is full.

## Still open

- License.
- The exact Node, Bun, and browser version matrix. The public build needs `AbortSignal.any` (Chrome 116, Firefox 124, Safari 17.4) and ES2023 (`Array.prototype.toSorted`). Node 22+ provides both. CommonJS is not a goal.
