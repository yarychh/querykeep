# Querykeep

Querykeep keeps a shared, in-memory snapshot of an asynchronous source and polls it on a schedule you set. One client shares concurrency, start spacing, and cooldown across queries, so several readers can observe the same key without each running its own timer. A `setInterval` plus a variable does not share a provider budget, keep a single in-flight call per key, or retain the last success across retries.

- One canonical key has one in-flight call. Readers share the snapshot.
- The client caps concurrency, spaces starts, and records the provider cooldown you parse from `Retry-After`.
- The last accepted success stays through retries and admission failures. The state holds the snapshot, the error, and the phase in one place.
- A query starts when you create it, keeps running with zero subscribers, and stops when you `pause` or `dispose` it.

Use it from a service, worker, dashboard, or SDK that polls a rate-limited source. TanStack Query is the better fit when you want a component cache, stale time, focus revalidation, or framework bindings. Querykeep does not do those.

RxJS is a peer dependency. It stays inside the library for scheduling, retries, and state. The quickstart does not use operators, subjects, or schedulers.

```sh
npm install querykeep rxjs
```

Node 22+ is the declared consumer runtime. The public build uses DOM and ES2023 types only, so a browser project does not need `@types/node`. Browsers need `AbortSignal.any` (Chrome 116, Firefox 124, Safari 17.4) and ES2023.

## Quickstart

```ts
import { createQueryClient } from 'querykeep';

type Departure = { line: string; when: string };

const client = createQueryClient({
  defaults: {
    intervalMs: 30_000,
    timeoutMs: 10_000,
    admissionTimeoutMs: 30_000,
    retry: { maxAttempts: 3, delayMs: 1_000 },
  },
  concurrency: 4,
  maxQueued: 256,
  providers: {
    transport: { concurrency: 2, minIntervalMs: 1_000 },
  },
});

async function fetchDepartures(stopId: string, signal: AbortSignal): Promise<Departure[]> {
  const response = await fetch(`https://example.test/stops/${stopId}/departures`, { signal });

  if (response.status === 429) {
    client.cooldown('transport', 5_000); // replace 5_000 with the delay you parsed from Retry-After
    throw new Error('rate limited');
  }

  if (!response.ok) throw new Error(`departures ${response.status}`);

  return (await response.json()) as Departure[];
}

const departures = client.query({
  key: ['departures', 'stop-A'],
  provider: 'transport',
  queryFn: ({ signal }) => fetchDepartures('stop-A', signal),
});

departures.state$.subscribe(renderState);
departures.snapshots$.subscribe(saveSnapshot);
departures.select((state) => state.snapshot?.data).subscribe(renderData);
departures.state(); // current state, no fetch
departures.refresh(); // true when this call delivered a trigger
departures.pause();
departures.resume();
departures.key; // canonical id, here '["departures","stop-A"]'
client.get<Departure[]>(['departures', 'stop-A']); // the same query
departures.dispose();
client.dispose();
```

`queryFn` receives `{ signal }` and returns `Promise<T>`. Close over inputs. Put every value that changes the result or who may see it into the key. A query starts when it is created. Subscribing does not fetch, and unsubscribing does not stop it.

Pass `initialSnapshot: { data, receivedAt }` when you already have a stored snapshot. Omit it otherwise.

`state()` returns a shallow copy of the state envelope and, when a snapshot is present, a shallow copy of `{ data, receivedAt }`. `state$` and `snapshots$` deliver those copies, not the objects stored by the reducer. Payload references are shared and must be treated as read-only. There is no deep clone.

`Query.key` is the canonical id from `keyId`. `client.get(key)` returns the live query for that key, or `undefined` when nothing is registered. The type argument on `get` is not checked. `query()` still throws when the key is already live, including while the first `query()` call for that key is still on the stack. `get` returns `undefined` during that window. Dispose removes the key. A disposed client has an empty registry, so `get` returns `undefined`.

`createQuery({ queryFn, intervalMs, timeoutMs, admissionTimeoutMs, retry, initialSnapshot, enabled, refreshOn$, enabled$ })` is the same pipeline with a private single-key admission object and no registry. Its `key` is the string `query`. Two `createQuery` results do not share that string: each has its own admission object.

## Defaults and state

Library defaults are an interval of 30 seconds, an attempt timeout of 10 seconds, an admission timeout of 30 seconds, and 3 attempts with a fixed 1 second delay. A client allows 4 concurrent attempts and 256 queued waiters.

A positive `intervalMs` is a safe integer. `intervalMs: false` runs once immediately, then only when you call `refresh()` or, if you opted in, when `refreshOn$` emits.

`maxAttempts` includes the first call. `delayMs` is a number or `({ retryNumber }) => number`. `retryNumber` starts at 1 for the first retry. `shouldRetry` is optional. `exponentialBackoff({ baseMs, capMs, jitter: 'full' | 'none', random? })` returns a delay function. Full jitter is `random() * min(cap, base * 2 ** (retryNumber - 1))`. The default `random` is `Math.random`. Provider cooldown is a separate client-wide delay, not a retry delay.

`state$` replays the current state, then later changes. Source failures stay on `state.error` and do not error or complete the stream. A throwing `state$` subscriber is caught by RxJS and reported later with `setTimeout`. That report can surface as an uncaught exception. It does not stop the query, consume an attempt, or prevent other subscribers from receiving the same update. Dispose is what completes `state$`, `snapshots$`, and `events$`.

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

`waiting` means the cycle is in admission. `fetching` starts when `queryFn` is called and lasts until that invocation settles. `backoff` is the retry delay. Otherwise the phase is `idle`. `receivedAt` is the wall-clock time of an accepted success. A later success replaces it even when `data` is the same reference or the same value. A restored timestamp stays until that happens.

`snapshots$` replays only the latest accepted snapshot, including `initialSnapshot`, then each later success. It does not replay history. Failures do not remove the last snapshot.

Keys use a restricted JSON form. `keyId(key)` is the canonical string: finite JSON values, array order preserved, plain-object keys sorted. Cycles, `NaN`, and exotic objects throw. Two live queries cannot share a canonical key. Dispose removes the key so it can be registered again. Unknown provider names throw when the query is created.

## Pause, resume, and errors

`canRun` is `!paused && !blocked`. `paused` is only the manual flag. `enabled: false` starts paused. `resume()` clears that flag and starts a cycle immediately when the external gate is also open. Opening the gate does the same. The new timer starts at that transition, so the next interval is measured from the resume or the gate opening. Missed interval ticks are not replayed. `intervalMs: false` does not start a repeating timer; the transition still runs one cycle.

`refresh()` returns `true` when it delivers a trigger to the cycle. It returns `false` when the query is disposed, paused, blocked, not executing, or a cycle is already in progress (admission, the attempt, or backoff). A call made from a `state$` subscriber is deferred until that notification finishes and returns `false`; the deferred call still runs. A skipped trigger is also reported on `events$`.

A retryable failure sets `error` and `phase: 'backoff'`. The snapshot stays. The next attempt keeps that error until it is replaced or a success clears it. Exhausted retries, or `shouldRetry` returning false, end the cycle `idle` with `error` set. A later tick may run again.

Admission queue overflow, admission timeout, and admission close set `error`, end the cycle, and do not count as source attempts. `client.dispose()` closes admission before it disposes each query, so a query still waiting in the queue records `AdmissionClosedError`. Pause and dispose abort work without writing an abort error over the existing error. A query that already holds a permit keeps that error. Attempt failures are caught inside the cycle. They do not error or complete `state$`.

## Advanced hooks

Omit these and the plain lifecycle above is the whole API.

`refreshOn$` joins the same trigger merge as the interval and `refresh()`. A value already present when the query is created, including the current value of a `BehaviorSubject`, is not a refresh and does not emit `triggerSkipped`. Later emissions join that merge. Emissions while a cycle is running, including admission waits and backoff, are skipped with reason `busy`. Emissions while the query cannot run are dropped with reason `cannotRun`, not queued. There is no trailing refresh after a busy cycle. Completion of `refreshOn$` does not stop polling or complete the query streams. An error is isolated: polling continues, the snapshot stays, and the failure is reported on `state.error` and `events$` as `triggerError`.

`enabled$` is an external gate, separate from `pause()` / `resume()`. `blocked` follows it. With no `enabled$`, `blocked` is false. The gate is subscribed before execution starts. A synchronous first value, such as from a `BehaviorSubject`, applies before the initial run, so an initial `false` blocks startup. If the source emits later, the gate stays open until that emission. An external `true` does not clear a manual pause. A transition into `canRun` schedules an immediate cycle. A transition to blocked cancels scheduling, admission, and backoff, aborts the active attempt, and keeps the snapshot. Gate errors are isolated the same way as `refreshOn$` and do not change the last gate value.

`events$` is a read-only diagnostic stream with no replay: `attemptStarted`, `attemptFailed`, `retryScheduled`, `succeeded`, `cycleFailed`, `triggerSkipped` (`reason` is `busy` or `cannotRun`), `triggerError`. It completes on dispose. It is not a debugger. Events do not carry the query key; read `query.key` where you subscribe.

`select` maps the state, applies `distinctUntilChanged`, and shares that view with `shareReplay({ bufferSize: 1, refCount: true })`. Refcount covers the derived view only. The query keeps running with zero select subscribers. `undefined` is a real value and is not dropped. Two subscribers to one select result share one projection. A new `select()` call is a new view. Combine views in your code:

```ts
import { combineLatest } from 'rxjs';

combineLatest([
  prices.select((state) => state.snapshot?.data),
  fx.select((state) => state.snapshot?.data),
]).subscribe(renderPair);
```

There is no combined-query type. Overlapping ticks are not switched in flight. Failures are caught inside the cycle so a later trigger still runs.

### Reading and shaping the stream

These operators are optional. An `async` function passed to `subscribe` does not order writes: the next notification can arrive before that function's promise settles.

```ts
import { auditTime, bufferTime, concatMap, firstValueFrom, pairwise, take, takeWhile } from 'rxjs';

await firstValueFrom(departures.select((state) => state.snapshot?.data));

departures.snapshots$.pipe(pairwise()).subscribe(([previous, next]) => {
  // equal payloads stay visible here because snapshots$ does not hide them
});

departures.state$.pipe(auditTime(1_000), bufferTime(5_000));

departures.state$.pipe(
  takeWhile((state) => !state.disposed),
  take(1),
);
```

`take` and `takeWhile` end that observer. They do not stop the query. `auditTime` and `bufferTime` are consumer-side only.

### Persistence

The library does not ship a store. Restore first, then create the query. Ordering writes is optional RxJS. Write errors and writes still running after dispose belong to that consumer stream. `dispose()` completes `snapshots$` after the current source notification. It does not flush external storage.

```ts
import { concatMap } from 'rxjs';

const restored = await readSnapshot(key);
const query = client.query({
  key,
  initialSnapshot: restored,
  queryFn: ({ signal }) => load(signal),
});

query.snapshots$.pipe(concatMap((snapshot) => writeSnapshot(key, snapshot))).subscribe({
  error: reportWriteFailure,
});
```

## Admission

Admission is a coordinator owned by the client, not a rate-limit operator. Limits are per client, not across processes or tabs.

- Client-wide concurrency, optional provider concurrency, and one physical invocation per key.
- Eligibility-ordered FIFO: a ticket blocked by its provider or its own key does not block other providers. A ticket that can start now does not need a free queue slot when every queued ticket is ineligible, and it does not jump a queued ticket that is already eligible.
- `minIntervalMs` is the gap between actual starts, measured with the monotonic elapsed clock.
- `cooldown(provider, delayMs)` only extends that provider's not-before time. It never shortens it. You parse `Retry-After` yourself.
- The queue is finite. Abort, timeout, and close remove the ticket and do not leak a permit. An empty queue cancels the pacing wake. The provider not-before time remains.
- Unknown providers fail when the query is created.

The attempt timeout starts when `queryFn` is called, not while the cycle is queued. Each invocation gets a new `AbortSignal` linked to pause, dispose, and `timeoutMs`. Unsubscribe aborts that signal but does not release the slot. The slot is released in the promise `finally`. The same key cannot start another invocation until that release. A later cycle waits in admission, under `admissionTimeoutMs`, instead of overlapping. A source that ignores abort and never settles can hold its client and provider slot indefinitely.

## Time

`now`, `elapsed`, and an RxJS `scheduler` on the client or `createQuery` are a test seam. `now` stamps `receivedAt` and defaults to `Date.now`. `elapsed` plus the scheduler drive intervals, backoff, timeouts, and pacing. `elapsed` defaults to `performance.now`. Do not persist monotonic values. Wall-clock changes do not by themselves release a cooldown that was recorded on the elapsed clock.

## Limits

This is one process, in memory. It is not a distributed cache.

- Browser timers can be throttled. Missed polls are not replayed. There is no background-service execution and no cross-tab leadership.
- There is no adaptive interval, reactive query parameters, or trailing refresh after a busy cycle.
- A non-cooperative `queryFn` can occupy a slot until its promise settles. Dispose does not cancel that promise.
- Payload bytes, write durability, and schema migration belong to the caller.
- No metrics server, HTTP server, framework bindings, or second execution engine is included.
