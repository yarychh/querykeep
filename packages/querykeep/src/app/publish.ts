import type { QueryState, Snapshot } from '../domain/state.js';

export function copySnapshot<T>(snapshot: Snapshot<T>): Snapshot<T> {
  return { data: snapshot.data, receivedAt: snapshot.receivedAt };
}

export function viewState<T>(current: QueryState<T>): QueryState<T> {
  return {
    snapshot: current.snapshot ? copySnapshot(current.snapshot) : undefined,
    error: current.error,
    phase: current.phase,
    paused: current.paused,
    blocked: current.blocked,
    disposed: current.disposed,
  };
}

export interface Publisher {
  defer(fn: () => void): void;
  /** Runs now, or queues the call and returns `pending` while a notification is in progress. */
  deferResult<T>(fn: () => T, pending: T): T;
  bracket(notify: () => void): void;
}

export function createPublisher(): Publisher {
  let emitting = 0;
  let flushScheduled = false;
  const deferred: Array<() => void> = [];

  const schedule = () => {
    if (flushScheduled) return;

    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;

      while (deferred.length > 0) deferred.shift()?.();
    });
  };

  return {
    defer(fn) {
      if (emitting === 0) {
        fn();

        return;
      }

      deferred.push(fn);
      schedule();
    },
    deferResult(fn, pending) {
      if (emitting === 0) return fn();

      deferred.push(() => {
        fn();
      });
      schedule();

      return pending;
    },
    bracket(notify) {
      emitting += 1;

      try {
        notify();
      } finally {
        emitting -= 1;
      }
    },
  };
}
