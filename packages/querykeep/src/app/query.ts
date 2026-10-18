import {
  asyncScheduler,
  distinctUntilChanged,
  exhaustMap,
  finalize,
  map,
  merge,
  shareReplay,
  tap,
  timer,
  Observable,
  ReplaySubject,
  Subject,
} from 'rxjs';
import type { SchedulerLike, Subscription } from 'rxjs';

import { assertQueryFn } from '../domain/attempt.js';
import type { QueryFn } from '../domain/attempt.js';
import type { QueryEvent } from '../domain/event.js';
import { resolvePolicy } from '../domain/policy.js';
import type { ResolvedRetry, RetryConfig } from '../domain/retry.js';
import { assertSnapshot, initialState, reduce, IllegalTransitionError } from '../domain/state.js';
import type { QueryState, Snapshot, Transition } from '../domain/state.js';
import { createAdmission } from '../runtime/admission.js';
import type { Admission } from '../runtime/admission.js';
import { runCycle } from './cycle.js';
import { copySnapshot, createPublisher, viewState } from './publish.js';

export interface Query<T> {
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

export interface QueryConfig<T> {
  readonly queryFn: QueryFn<T>;
  readonly intervalMs?: number | false;
  readonly timeoutMs?: number;
  readonly admissionTimeoutMs?: number;
  readonly retry?: RetryConfig;
  readonly initialSnapshot?: Snapshot<T>;
  readonly enabled?: boolean;
  readonly refreshOn$?: Observable<unknown>;
  readonly enabled$?: Observable<boolean>;
  readonly now?: () => number;
  readonly elapsed?: () => number;
  readonly scheduler?: SchedulerLike;
}

export interface ManagedQueryConfig<T> {
  readonly queryFn: QueryFn<T>;
  readonly intervalMs: number | false;
  readonly timeoutMs: number;
  readonly admissionTimeoutMs: number;
  readonly retry: ResolvedRetry;
  readonly initialSnapshot: Snapshot<T> | undefined;
  readonly enabled: boolean;
  readonly refreshOn$: Observable<unknown> | undefined;
  readonly enabled$: Observable<boolean> | undefined;
  readonly now: () => number;
  readonly scheduler: SchedulerLike;
  readonly admission: Admission;
  readonly key: string;
  readonly provider: string | undefined;
  readonly onDispose?: () => void;
}

function assertObservable(value: unknown, name: string): void {
  if (
    value == null ||
    typeof value !== 'object' ||
    typeof (value as { subscribe?: unknown }).subscribe !== 'function'
  ) {
    throw new Error(`Invalid ${name}`);
  }
}

export function createQuery<T>(config: QueryConfig<T>): Query<T> {
  assertQueryFn(config.queryFn);

  if (config.refreshOn$) assertObservable(config.refreshOn$, 'refreshOn$');

  if (config.enabled$) assertObservable(config.enabled$, 'enabled$');

  const scheduler = config.scheduler ?? asyncScheduler;
  const elapsed = config.elapsed ?? (() => performance.now());
  const policy = resolvePolicy(config);

  return createManagedQuery({
    queryFn: config.queryFn,
    intervalMs: policy.intervalMs,
    timeoutMs: policy.timeoutMs,
    admissionTimeoutMs: policy.admissionTimeoutMs,
    retry: policy.retry,
    initialSnapshot: assertSnapshot(config.initialSnapshot),
    enabled: config.enabled !== false,
    refreshOn$: config.refreshOn$,
    enabled$: config.enabled$,
    now: config.now ?? (() => Date.now()),
    scheduler,
    admission: createAdmission({
      concurrency: 1,
      maxQueued: 1,
      providers: new Map(),
      elapsed,
      scheduler,
    }),
    key: 'query',
    provider: undefined,
  });
}

export function createManagedQuery<T>(config: ManagedQueryConfig<T>): Query<T> {
  let state = initialState<T>(
    !config.enabled,
    config.initialSnapshot ? copySnapshot(config.initialSnapshot) : undefined,
  );
  const stateSubject = new Subject<QueryState<T>>();
  const snapshotsSubject = new ReplaySubject<Snapshot<T>>(1);
  const eventsSubject = new Subject<QueryEvent<T>>();
  const refresh$ = new Subject<void>();
  const disposeController = new AbortController();
  const publisher = createPublisher();

  if (state.snapshot) snapshotsSubject.next(copySnapshot(state.snapshot));

  let execution: Subscription | undefined;
  let gateSub: Subscription | undefined;
  let refreshOnSub: Subscription | undefined;
  let cycleActive = false;
  let triggersArmed = false;

  const emitState = (event: Transition<T>) => {
    const next = reduce(state, event);

    if (next === state) return;

    state = next;
    publisher.bracket(() => {
      stateSubject.next(viewState(state));
    });
  };

  const publish = (event: QueryEvent<T>) => {
    if (eventsSubject.closed || state.disposed) return;

    const outgoing =
      event.type === 'succeeded'
        ? { type: 'succeeded' as const, snapshot: copySnapshot(event.snapshot) }
        : event;

    publisher.bracket(() => {
      eventsSubject.next(outgoing);
    });
  };

  const publishSnapshot = (snapshot: Snapshot<T>) => {
    if (snapshotsSubject.closed) return;

    publisher.bracket(() => {
      snapshotsSubject.next(copySnapshot(snapshot));
    });
  };

  const canRun = () => !state.paused && !state.blocked && !state.disposed;

  const requestRefresh = (): boolean => {
    if (state.disposed) return false;

    if (!canRun() || !execution || cycleActive) {
      publish({
        type: 'triggerSkipped',
        reason: !canRun() || !execution ? 'cannotRun' : 'busy',
      });

      return false;
    }

    refresh$.next();

    return true;
  };

  const connect = () => {
    if (execution || !canRun()) return;

    const interval$ =
      config.intervalMs === false
        ? timer(0, config.scheduler)
        : timer(0, config.intervalMs, config.scheduler);

    execution = merge(interval$, refresh$)
      .pipe(
        tap(() => {
          if (cycleActive) publish({ type: 'triggerSkipped', reason: 'busy' });
        }),
        exhaustMap(() => {
          const controller = new AbortController();
          const abortFromDispose = () => controller.abort();

          disposeController.signal.addEventListener('abort', abortFromDispose);
          cycleActive = true;

          return runCycle({
            queryFn: config.queryFn,
            timeoutMs: config.timeoutMs,
            admissionTimeoutMs: config.admissionTimeoutMs,
            retry: config.retry,
            scheduler: config.scheduler,
            now: config.now,
            admission: config.admission,
            key: config.key,
            provider: config.provider,
            signal: controller.signal,
            emit: emitState,
            publish,
            publishSnapshot,
          }).pipe(
            finalize(() => {
              cycleActive = false;
              disposeController.signal.removeEventListener('abort', abortFromDispose);
              controller.abort();
            }),
          );
        }),
      )
      .subscribe({
        // runCycle maps source and admission failures to EMPTY. Reaching here is a
        // defect, or a leak; IllegalTransitionError is rethrown and not stored.
        error: (error) => {
          if (error instanceof IllegalTransitionError) throw error;

          emitState({ type: 'triggerError', error });
          publish({ type: 'triggerError', error });
        },
      });
  };

  const disconnect = () => {
    execution?.unsubscribe();
    execution = undefined;
    emitState({ type: 'workCancelled' });
  };

  const sync = (wasRunning: boolean) => {
    const running = canRun();

    if (wasRunning && !running) disconnect();
    else if (!wasRunning && running) connect();
  };

  const setPaused = (paused: boolean) => {
    publisher.defer(() => {
      if (state.disposed || state.paused === paused) return;

      const wasRunning = canRun();

      emitState({ type: 'paused', paused });
      sync(wasRunning);
    });
  };

  const setBlocked = (blocked: boolean) => {
    publisher.defer(() => {
      if (state.disposed || state.blocked === blocked) return;

      const wasRunning = canRun();

      emitState({ type: 'blocked', blocked });
      sync(wasRunning);
    });
  };

  const triggerError = (error: unknown) => {
    publisher.defer(() => {
      if (state.disposed) return;

      emitState({ type: 'triggerError', error });
      publish({ type: 'triggerError', error });
    });
  };

  if (config.enabled$) {
    gateSub = config.enabled$.subscribe({
      next: (value) => setBlocked(value !== true),
      error: (error) => triggerError(error),
    });
  }

  if (config.refreshOn$) {
    refreshOnSub = config.refreshOn$.subscribe({
      next: () => {
        publisher.defer(() => {
          if (!triggersArmed || state.disposed) return;

          requestRefresh();
        });
      },
      error: (error) => triggerError(error),
    });
  }

  if (canRun()) connect();

  triggersArmed = true;

  // Replay the current state under the reentrancy guard. BehaviorSubject would emit
  // that first value outside emitState, so dispose/pause from that callback could
  // complete the stream mid-notification.
  const state$ = new Observable<QueryState<T>>((subscriber) => {
    publisher.bracket(() => {
      subscriber.next(viewState(state));
    });

    return stateSubject.subscribe(subscriber);
  });
  const query: Query<T> = {
    key: config.key,
    state$,
    snapshots$: snapshotsSubject.asObservable(),
    events$: eventsSubject.asObservable(),
    select(project) {
      return state$.pipe(
        map(project),
        distinctUntilChanged(),
        shareReplay({ bufferSize: 1, refCount: true }),
      );
    },
    state() {
      return viewState(state);
    },
    refresh() {
      return publisher.deferResult(() => requestRefresh(), false);
    },
    pause() {
      setPaused(true);
    },
    resume() {
      setPaused(false);
    },
    dispose() {
      publisher.defer(() => {
        if (state.disposed) return;

        gateSub?.unsubscribe();
        refreshOnSub?.unsubscribe();
        execution?.unsubscribe();
        execution = undefined;
        disposeController.abort();
        config.onDispose?.();
        emitState({ type: 'disposed' });
        publisher.bracket(() => {
          stateSubject.complete();
          snapshotsSubject.complete();
          eventsSubject.complete();
          refresh$.complete();
        });
      });
    },
  };

  return query;
}
