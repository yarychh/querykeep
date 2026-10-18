---
title: API
description: Every export from the querykeep package entry.
---

Import from `querykeep`. RxJS types such as `Observable` and `SchedulerLike` come from `rxjs`.

## Factories

### `createQueryClient(config?): QueryClient`

```ts
interface ClientConfig {
  defaults?: {
    intervalMs?: number | false;
    timeoutMs?: number;
    admissionTimeoutMs?: number;
    retry?: RetryConfig;
  };
  concurrency?: number; // default 4
  maxQueued?: number; // default 256
  providers?: Readonly<Record<string, ProviderLimits>>;
  now?: () => number;
  elapsed?: () => number;
  scheduler?: SchedulerLike;
}

interface ProviderLimits {
  concurrency?: number;
  minIntervalMs?: number;
}
```

`now` stamps `receivedAt`. `elapsed` and `scheduler` drive pacing, cooldown, intervals, backoff, and timeouts. They are a test seam.

```ts
interface QueryClient {
  query<T>(config: ClientQueryConfig<T>): Query<T>;
  get<T = unknown>(key: QueryKey): Query<T> | undefined;
  cooldown(provider: string, delayMs: number): void;
  dispose(): void;
}
```

`query` throws on a disposed client, an unknown provider, a duplicate canonical key, or an invalid option. `get` canonicalizes `key` and returns the live query, or `undefined` when the key is missing, still being constructed, or already disposed. `T` is not checked. A disposed client returns `undefined` from `get`. `cooldown` throws on a disposed client or an unknown provider, and it only extends that provider's not-before time. `dispose` closes admission, then disposes every query. A second `dispose` does nothing. A later `query` throws.

```ts
interface ClientQueryConfig<T> {
  key: QueryKey;
  queryFn: QueryFn<T>;
  provider?: string;
  intervalMs?: number | false;
  timeoutMs?: number;
  admissionTimeoutMs?: number;
  retry?: RetryConfig;
  initialSnapshot?: Snapshot<T>;
  enabled?: boolean;
  refreshOn$?: Observable<unknown>;
  enabled$?: Observable<boolean>;
}
```

Per-query timing overrides the client defaults. Omitted fields inherit them.

### `createQuery(config): Query<T>`

Same cycle as a client query, with a private admission object: one key, one running attempt, one queued waiter. No registry and no `cooldown`. `query.key` is the string `query`.

`QueryConfig<T>` is `queryFn` plus the timing fields, `initialSnapshot`, `enabled`, `refreshOn$`, `enabled$`, and the `now`, `elapsed`, and `scheduler` test seam.

## Query

```ts
interface Query<T> {
  readonly key: string;
  readonly state$: Observable<QueryState<T>>;
  readonly snapshots$: Observable<Snapshot<T>>;
  readonly events$: Observable<QueryEvent<T>>;
  select<R>(project: (state: QueryState<T>) => R): Observable<R>;
  state(): QueryState<T>;
  refresh(): boolean;
  pause(): void;
  resume(): void;
  dispose(): void;
}
```

`key` is the canonical id. `state()` copies the envelope and `{ data, receivedAt }` and does not fetch. `refresh()` returns `true` when it delivers a trigger. It returns `false` when the query is disposed, paused, blocked, not executing, or a cycle is already running. From a `state$` subscriber it returns `false` and runs after that notification. `pause` and `resume` change only the manual flag. `dispose` completes `state$`, `snapshots$`, and `events$`.

`select` maps, applies `distinctUntilChanged`, and shares that view with `shareReplay({ bufferSize: 1, refCount: true })`. The query keeps running with zero select subscribers.

## State

```ts
interface Snapshot<T> {
  readonly data: T;
  readonly receivedAt: number;
}

type Phase = 'idle' | 'waiting' | 'fetching' | 'backoff';

interface QueryState<T> {
  readonly snapshot: Snapshot<T> | undefined;
  readonly error: unknown;
  readonly phase: Phase;
  readonly paused: boolean;
  readonly blocked: boolean;
  readonly disposed: boolean;
}
```

`waiting` is admission. `fetching` starts when `queryFn` is called. `backoff` is the retry delay.

## Events

```ts
type TriggerSkipReason = 'busy' | 'cannotRun';

type QueryEvent<T> =
  | { readonly type: 'attemptStarted' }
  | { readonly type: 'attemptFailed'; readonly error: unknown }
  | { readonly type: 'retryScheduled'; readonly retryNumber: number; readonly delayMs: number }
  | { readonly type: 'succeeded'; readonly snapshot: Snapshot<T> }
  | { readonly type: 'cycleFailed'; readonly error: unknown }
  | { readonly type: 'triggerSkipped'; readonly reason: TriggerSkipReason }
  | { readonly type: 'triggerError'; readonly error: unknown };
```

`events$` does not replay. `busy` means a cycle is already in progress. `cannotRun` means paused, blocked, or not executing.

## Keys, retries, and the source function

```ts
type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

type QueryKey = readonly JsonValue[];

function keyId(key: QueryKey): string;

interface QueryFnContext {
  readonly signal: AbortSignal;
}

type QueryFn<T> = (context: QueryFnContext) => Promise<T>;

interface RetryDelayContext {
  readonly retryNumber: number;
}

type DelayMs = number | ((context: RetryDelayContext) => number);

interface RetryConfig {
  readonly maxAttempts?: number;
  readonly delayMs?: DelayMs;
  readonly shouldRetry?: (error: unknown) => boolean;
}

function exponentialBackoff(options: {
  readonly baseMs: number;
  readonly capMs: number;
  readonly jitter: 'full' | 'none';
  readonly random?: () => number;
}): (context: RetryDelayContext) => number;
```

`keyId` keeps array order, sorts plain-object keys, and throws on cycles, `NaN`, non-finite numbers, and exotic objects. `maxAttempts` includes the first call. `retryNumber` starts at 1 for the first retry. Full jitter is `random() * min(cap, base * 2 ** (retryNumber - 1))`. The default `random` is `Math.random`.

## Errors

| Class                    | When                                                                 |
| ------------------------ | -------------------------------------------------------------------- |
| `AdmissionOverflowError` | The queue is at `maxQueued` and this ticket cannot start immediately |
| `AdmissionTimeoutError`  | The wait exceeded `admissionTimeoutMs`                               |
| `AdmissionClosedError`   | `client.dispose()` closed admission while the cycle was queued       |
| `AttemptTimeoutError`    | `queryFn` did not settle within `timeoutMs` after it was called      |
| `IllegalTransitionError` | A defect in this library. It is not stored on `state.error`          |

Admission errors end the cycle, sit on `state.error`, and do not count as source attempts. `shouldRetry` is not consulted for them. Pause and dispose do not overwrite `state.error` with a cancellation error.
