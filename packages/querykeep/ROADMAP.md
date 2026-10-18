# Roadmap

Candidate work after the public alpha. Each item is independent. Pick one, open an issue or a branch, and move its status. `CONTRACT.md` stays the normative document; an item that changes behavior updates the contract in the same change.

Source: a comparison with `shieldcache`, `lastcache`, `ubgo/cache` (Go), Caffeine and Resilience4j (Java), FusionCache (.NET), Moka (Rust), and `advanced-caching`, `coalescer`, `cashews` (Python). The comparison notes are not kept in this repository.

## Admission rule

A feature belongs in the library when all three hold:

1. Readers stay passive. Subscribing does not fetch and unsubscribing does not stop anything.
2. The behavior lives inside one client. No process, tab, or node is coordinated.
3. No payload codec is needed. The library never encodes `T`.

A request that fails one test becomes a recipe or a separate package.

## Status values

`idea` has no caller yet. `ready` has a demonstrated caller and an agreed shape. `in progress` has a branch. `done` is released and documented. `rejected` stays listed so the reason is not lost.

## Items

### R1 — Stale data policy statement

| Field    | Value                                                                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status   | ready                                                                                                                                                                                                                           |
| Size     | docs only                                                                                                                                                                                                                       |
| Lands in | `README.md`, `apps/docs/.../guides/state.md`                                                                                                                                                                                    |
| Contract | no change                                                                                                                                                                                                                       |
| Shape    | One paragraph: the snapshot stays until dispose, there is no maximum age, `receivedAt` is the only age signal, and a consumer that needs a cap applies it in a `select` view or at the point of use                             |
| Why      | Other libraries cap stale serving (`StaleTTL`, `FailSafeMaxDuration`) because `get()` returns a bare value. Querykeep exposes `receivedAt` instead. The choice is sound but is stated in several places and nowhere as a policy |

### R2 — Age-aware view recipe

| Field    | Value                                                                                                                                                                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status   | ready                                                                                                                                                                                                                                         |
| Size     | docs only                                                                                                                                                                                                                                     |
| Lands in | `apps/docs/.../guides/recipes.md`                                                                                                                                                                                                             |
| Contract | no change                                                                                                                                                                                                                                     |
| Shape    | `combineLatest([query.state$, timer(0, tickMs)])` mapped to `{ data, ageMs, stale }`. State the trap: a plain `select` re-evaluates only when `state$` emits, so a value that becomes stale while nothing else changes does not flip the view |
| Why      | Freshness is a consumer predicate by contract. The predicate depends on the clock, and the clock is not a state change                                                                                                                        |

### R3 — Conditional refresh recipe (ETag / If-Modified-Since)

| Field    | Value                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status   | ready                                                                                                                                                                                                                                                                                                                                                                                                  |
| Size     | docs only                                                                                                                                                                                                                                                                                                                                                                                              |
| Lands in | `apps/docs/.../guides/recipes.md`                                                                                                                                                                                                                                                                                                                                                                      |
| Contract | no change                                                                                                                                                                                                                                                                                                                                                                                              |
| Shape    | Closure variables `etag` and `last` next to `queryFn`. Send `If-None-Match`. On 304 return `last`. State three facts: a 304 produces a new snapshot with a new `receivedAt` and equal data (A17); the persistence recipe then writes on every 304 unless the consumer adds `distinctUntilChanged` on `data`; `initialSnapshot` does not restore the ETag, so persist it next to the data or inside `T` |
| Why      | FusionCache conditional refresh and Caffeine `reload(key, oldValue)` show the demand. The closure form works today and does not touch the API                                                                                                                                                                                                                                                          |

### R4 — Metrics from `events$` recipe

| Field    | Value                                                                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status   | ready                                                                                                                                                                                                                    |
| Size     | docs only                                                                                                                                                                                                                |
| Lands in | `apps/docs/.../guides/recipes.md`                                                                                                                                                                                        |
| Contract | no change                                                                                                                                                                                                                |
| Shape    | Fold `events$` into counters keyed by `query.key`. Measure attempt duration by pairing `attemptStarted` with `succeeded` or `attemptFailed` inside the consumer. Show one `scan` and one Prometheus-style counter update |
| Why      | Shows what the current stream can do before any event field is added. Also exposes the gaps that R6 fills                                                                                                                |

### R5 — Stagger query creation recipe

| Field    | Value                                                                                                                                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status   | ready                                                                                                                                                                                                                            |
| Size     | docs only                                                                                                                                                                                                                        |
| Lands in | `apps/docs/.../guides/recipes.md`, one sentence in `guides/admission.md`                                                                                                                                                         |
| Contract | no change                                                                                                                                                                                                                        |
| Shape    | The interval timer anchors at `query()`. Creating N queries with a spacing of `intervalMs / N` spreads their phases without an option. Note what admission already does inside one client and what it cannot do across processes |
| Why      | Answers the jitter question for the common case and leaves R9 for callers who cannot stagger creation                                                                                                                            |

### R6 — Timing fields on `events$`

| Field    | Value                                                                                                                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status   | idea                                                                                                                                                                                                  |
| Size     | small, additive                                                                                                                                                                                       |
| Lands in | `src/domain/event.ts`, `src/app/cycle.ts`, `src/runtime/admission.ts`                                                                                                                                 |
| Contract | additive. Existing fields keep their meaning                                                                                                                                                          |
| Shape    | `succeeded` and `attemptFailed` gain `durationMs` (from `elapsed`). A new `admitted { waitedMs }` event between `waiting` and `attemptStarted`. `cycleFailed` for an admission error gains `waitedMs` |
| Open     | Whether `admitted` is a state transition or only an `events$` fact. The reducer does not need it; `phase` already moves `waiting → fetching`                                                          |
| Why      | Queue wait and attempt duration are the two histograms every comparable library exposes. The coordinator and the attempt already know both numbers                                                    |

### R7 — `failedAt` on `QueryState`

| Field    | Value                                                                                                                                                                                                                   |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status   | idea                                                                                                                                                                                                                    |
| Size     | small, additive                                                                                                                                                                                                         |
| Lands in | `src/domain/state.ts`, `src/app/publish.ts`, README state section                                                                                                                                                       |
| Contract | additive. `error` semantics do not change                                                                                                                                                                               |
| Shape    | `failedAt: number \| undefined` stamped with `now` on `attemptFailed` and `cycleFailed`, cleared on `succeeded`. Optionally `consecutiveFailures: number` counted per cycle, reset on success                           |
| Open     | Whether admission failures stamp `failedAt`. They are not source attempts, but the reader still sees `error`. Proposal: yes, because the field dates the error the reader is looking at                                 |
| Why      | `receivedAt` dates the success and nothing dates the failure. A reader cannot tell a first blip from a source that has failed for an hour. `lastcache` anchors its stale window at the last success for the same reason |

### R8 — Key and attempt number in `QueryFnContext`

| Field    | Value                                                                                                                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status   | idea                                                                                                                                                                                    |
| Size     | small, additive                                                                                                                                                                         |
| Lands in | `src/domain/attempt.ts`, `src/runtime/attempt.ts`, `src/app/cycle.ts`                                                                                                                   |
| Contract | additive. `{ signal }` keeps working                                                                                                                                                    |
| Shape    | `{ signal, key, attempt }` where `key` is the canonical id and `attempt` starts at 1 per cycle. Possibly `previous: Snapshot<T> \| undefined` for conditional refresh without a closure |
| Open     | Whether `previous` belongs here or stays a closure (R3). It makes `initialSnapshot` and the ETag arrive together, which the closure cannot do                                           |
| Why      | A tracing span needs a name and a retry number. Today `queryFn` must close over the key and cannot learn the attempt number                                                             |

### R9 — Interval jitter option

| Field    | Value                                                                                                                                                                                                                                                                                                                       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status   | idea                                                                                                                                                                                                                                                                                                                        |
| Size     | medium, opt-in                                                                                                                                                                                                                                                                                                              |
| Lands in | `src/domain/policy.ts`, `src/app/query.ts`, `src/app/client.ts` (`random` seam), CONTRACT rules                                                                                                                                                                                                                             |
| Contract | opt-in. With the option unset the timer is unchanged                                                                                                                                                                                                                                                                        |
| Shape    | Prefer a per-query phase offset: `timer(random() * jitterMs, intervalMs)`. Cadence stays fixed and "the next interval is measured from the resume" stays true. Per-tick jitter is the alternative and changes the cadence every tick. Add `random` next to `now` and `elapsed` so the virtual scheduler stays deterministic |
| Open     | Where the option sits: client defaults only, or also per query. Whether the first cycle is also delayed; proposal: no, the first cycle stays immediate                                                                                                                                                                      |
| Why      | Inside one client admission already spreads starts. Across processes or tabs nothing does, and a fleet that boots from one deploy polls in lockstep. The PRD lists jitter as in force but only retry jitter shipped                                                                                                         |
| Needs    | R5 first. Pick up R9 only when a caller cannot stagger creation                                                                                                                                                                                                                                                             |

### R10 — Client-level diagnostic stream

| Field    | Value                                                                                                                                                                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status   | idea                                                                                                                                                                                                                                    |
| Size     | medium, additive                                                                                                                                                                                                                        |
| Lands in | `src/app/client.ts`, `src/runtime/admission.ts`, `src/domain/event.ts`                                                                                                                                                                  |
| Contract | additive. Per-query `events$` stays as is                                                                                                                                                                                               |
| Shape    | `client.events$` with `{ key, event }` for every query event plus admission facts the queries cannot see: `queryCreated`, `queryDisposed`, `queueOverflow`, `cooldownRecorded { provider, untilMs }`, and possibly a `queueDepth` gauge |
| Open     | Whether `queueDepth` is an event or a `client.stats()` read. Events fit the existing style; a read is cheaper for a gauge                                                                                                               |
| Why      | A consumer with fifty queries should not subscribe fifty times to learn that the provider is in cooldown. Needs R6 so the payloads carry timing                                                                                         |
| Needs    | R6                                                                                                                                                                                                                                      |

## Rejected

Kept so the reason stays with the decision.

| Item                                        | Reason                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `maxAgeMs` that drops or hides the snapshot | Breaks "the snapshot stays until dispose" and makes a wall-clock decision inside the library. R1 and R2 cover the need                           |
| `stale: boolean` on `QueryState`            | A boolean needs a threshold, and a library threshold is stale time by another name. Freshness is a consumer predicate                            |
| Built-in OpenTelemetry or Prometheus export | Fails the codec test by analogy: it binds the library to an exporter API. R4, R6, and R10 give the consumer the facts; the exporter stays theirs |
| Cross-tab leader                            | Fails test 2. A companion package may hold a `Web Locks` leader and drive `enabled$`; the library does not                                       |
| Shared cooldown across instances            | Fails test 2 and needs a transport. A consumer can subscribe a pub/sub channel and call `client.cooldown` on each instance                       |
| Storage port                                | The persistence recipe is five lines of consumer RxJS. A port adds a codec and durability semantics (PRD §1)                                     |
| Eviction                                    | There is no second map to evict. Live queries and the admission queue are the only bounded collections (PRD Q-08)                                |

## Already listed elsewhere

Adaptive intervals, reactive parameters, trailing refresh after a busy cycle, and richer quotas stay in the PRD "After alpha" row. They are not repeated here because they came from the original design, not from this comparison.
