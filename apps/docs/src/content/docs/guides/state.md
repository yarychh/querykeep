---
title: State
description: Phases, pause, the external gate, and what subscribers are allowed to do.
---

`state$` replays the current state, then later changes. Source failures stay on `state.error`. They do not error or complete the stream. Dispose completes `state$`, `snapshots$`, and `events$`.

```ts
interface QueryState<T> {
  snapshot: { data: T; receivedAt: number } | undefined;
  error: unknown;
  phase: 'idle' | 'waiting' | 'fetching' | 'backoff';
  paused: boolean;
  blocked: boolean;
  disposed: boolean;
}
```

`waiting` means the cycle is in admission. `fetching` starts when `queryFn` is called and lasts until that invocation settles. `backoff` is the retry delay. Otherwise the phase is `idle`. `receivedAt` is the wall-clock time of an accepted success. A later success replaces it even when `data` is the same reference. A restored timestamp stays until that happens.

`snapshots$` replays only the latest accepted snapshot, including `initialSnapshot`, then each later success. Failures do not remove the last snapshot.

`canRun` is `!paused && !blocked`. `paused` is only the manual flag. `enabled: false` starts paused. `resume()` clears that flag and starts a cycle immediately when the external gate is also open. Opening the gate does the same. The new timer starts at that transition, so the next interval is measured from the resume or the gate opening. Missed interval ticks are not replayed. `intervalMs: false` does not start a repeating timer; the transition still runs one cycle.

`refresh()` returns `true` when it delivers a trigger. It returns `false` when the query is disposed, cannot run, or a cycle is already in progress. A call from a `state$` subscriber is deferred and returns `false`; the deferred call still runs.

A retryable failure sets `error` and `phase: 'backoff'`. The snapshot stays. The next attempt keeps that error until a success clears it. Exhausted retries, or `shouldRetry` returning false, end the cycle `idle` with `error` set. A later tick may run again.

Pause and dispose abort work without writing an abort error over the existing error. `client.dispose()` closes admission first. A query still waiting in the queue records `AdmissionClosedError`. A query that already holds a permit keeps its current error.

## refreshOn$ and enabled$

Omit these and the plain lifecycle is the whole API.

`refreshOn$` joins the same trigger merge as the interval and `refresh()`. A value already present when the query is created, including the current value of a `BehaviorSubject`, is not a refresh and does not emit `triggerSkipped`. Later emissions join that merge. A cycle already in progress, including admission and backoff, skips the emission with reason `busy`. Emissions while the query cannot run are dropped with reason `cannotRun`, not queued. There is no trailing refresh after a busy cycle. Completion of `refreshOn$` does not stop polling. An error is isolated on `state.error` and `events$` as `triggerError`.

`enabled$` is an external gate, separate from `pause()` and `resume()`. `blocked` follows it. The gate is subscribed before execution starts. A synchronous first `false`, such as from a `BehaviorSubject`, blocks startup. An external `true` does not clear a manual pause. A transition into `canRun` schedules an immediate cycle. A transition to blocked cancels scheduling, admission, and backoff, aborts the active attempt, and keeps the snapshot.

`pause()`, `resume()`, `refresh()`, and `dispose()` called from a `state$` subscriber run after that notification. They do not complete the stream mid-delivery.

## select and events$

`select` maps the state, applies `distinctUntilChanged`, and shares that view. The query keeps running with zero select subscribers. `undefined` is a real value and is not dropped. Two subscribers to one select result share one projection. A new `select()` call is a new view.

`events$` does not replay. It emits `attemptStarted`, `attemptFailed`, `retryScheduled`, `succeeded`, `cycleFailed`, `triggerSkipped` (`reason` is `busy` or `cannotRun`), and `triggerError`, then completes on dispose. Events do not carry the query key. Read `query.key` where you subscribe.

`maxAttempts` includes the first call. `delayMs` is a number or `({ retryNumber }) => number`. `retryNumber` starts at 1 for the first retry. `exponentialBackoff({ baseMs, capMs, jitter: 'full' | 'none', random? })` returns a delay function. Full jitter is `random() * min(cap, base * 2 ** (retryNumber - 1))`. The default `random` is `Math.random`.
