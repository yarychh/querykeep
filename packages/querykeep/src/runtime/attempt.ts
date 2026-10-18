import { Observable, timer } from 'rxjs';
import type { SchedulerLike } from 'rxjs';

import { AttemptTimeoutError, CancelledError } from '../domain/attempt.js';
import type { QueryFn } from '../domain/attempt.js';
import { IllegalTransitionError } from '../domain/state.js';

export function invokeAttempt<T>(options: {
  readonly queryFn: QueryFn<T>;
  readonly timeoutMs: number;
  readonly scheduler: SchedulerLike;
  readonly signal: AbortSignal;
  readonly release: () => void;
  readonly onStart: () => void;
}): Observable<T> {
  return new Observable((subscriber) => {
    let released = false;
    const releaseOnce = () => {
      if (released) return;

      released = true;
      options.release();
    };

    if (options.signal.aborted) {
      releaseOnce();
      subscriber.error(new CancelledError());

      return;
    }

    const local = new AbortController();
    const timeoutController = new AbortController();
    const signal = AbortSignal.any([options.signal, local.signal, timeoutController.signal]);
    let settled = false;

    const report = (error: unknown) => {
      if (subscriber.closed) return;

      try {
        subscriber.error(error);
      } catch {
        // The destination already rejected this notification.
      }
    };

    // The promise has settled, so the permit can be released before the notification
    // error propagates. Timeout and cancellation keep the permit until settlement.
    const terminate = (error: unknown) => {
      releaseOnce();
      report(error);
    };

    const fail = (error: unknown) => {
      if (settled) return;

      settled = true;

      try {
        if (!subscriber.closed) subscriber.error(error);
      } catch (notifyError) {
        report(notifyError);
      }
    };

    const timeoutSub = timer(options.timeoutMs, options.scheduler).subscribe(() => {
      if (settled) return;

      timeoutController.abort();
      fail(new AttemptTimeoutError());
    });

    let task: Promise<T>;

    try {
      options.onStart();
      task = Promise.resolve(options.queryFn({ signal }));
    } catch (error) {
      timeoutSub.unsubscribe();
      releaseOnce();

      if (error instanceof IllegalTransitionError) throw error;

      fail(error);

      return;
    }

    void task
      .then(
        (value) => {
          if (settled || signal.aborted || subscriber.closed) return;

          settled = true;

          try {
            subscriber.next(value);
            subscriber.complete();
          } catch (error) {
            terminate(error);
          }
        },
        (error) => {
          if (settled || signal.aborted || subscriber.closed) return;

          settled = true;

          try {
            subscriber.error(error);
          } catch (notifyError) {
            terminate(notifyError);
          }
        },
      )
      .catch(() => {});
    void task.finally(releaseOnce).catch(() => {});

    return () => {
      settled = true;
      local.abort();
      timeoutSub.unsubscribe();
    };
  });
}
