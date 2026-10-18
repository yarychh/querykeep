import {
  catchError,
  defer as deferObservable,
  EMPTY,
  mergeMap,
  retry,
  tap,
  throwError,
  timer,
} from 'rxjs';
import type { Observable, SchedulerLike } from 'rxjs';

import { isAdmissionError } from '../domain/admission.js';
import { CancelledError } from '../domain/attempt.js';
import type { QueryFn } from '../domain/attempt.js';
import type { QueryEvent } from '../domain/event.js';
import { decideFailure } from '../domain/retry.js';
import type { ResolvedRetry } from '../domain/retry.js';
import { IllegalTransitionError } from '../domain/state.js';
import type { Snapshot, Transition } from '../domain/state.js';
import { invokeAttempt } from '../runtime/attempt.js';
import type { Admission } from '../runtime/admission.js';

export function runCycle<T>(options: {
  readonly queryFn: QueryFn<T>;
  readonly timeoutMs: number;
  readonly admissionTimeoutMs: number;
  readonly retry: ResolvedRetry;
  readonly scheduler: SchedulerLike;
  readonly now: () => number;
  readonly admission: Admission;
  readonly key: string;
  readonly provider: string | undefined;
  readonly signal: AbortSignal;
  readonly emit: (event: Transition<T>) => void;
  readonly publish: (event: QueryEvent<T>) => void;
  readonly publishSnapshot: (snapshot: Snapshot<T>) => void;
}): Observable<T> {
  const source = deferObservable(() => {
    options.emit({ type: 'waiting' });

    return options.admission
      .acquire({
        key: options.key,
        provider: options.provider,
        signal: options.signal,
        timeoutMs: options.admissionTimeoutMs,
      })
      .pipe(
        mergeMap((permit) =>
          invokeAttempt({
            queryFn: options.queryFn,
            timeoutMs: options.timeoutMs,
            scheduler: options.scheduler,
            signal: options.signal,
            release: () => permit.release(),
            onStart: () => {
              options.emit({ type: 'attemptStarted' });
              options.publish({ type: 'attemptStarted' });
            },
          }),
        ),
      );
  });

  return source.pipe(
    tap({
      next: (data) => {
        const snapshot = { data, receivedAt: options.now() };

        options.emit({ type: 'succeeded', snapshot });
        options.publishSnapshot(snapshot);
        options.publish({ type: 'succeeded', snapshot });
      },
      error: (error) => {
        if (
          error instanceof IllegalTransitionError ||
          isAdmissionError(error) ||
          error instanceof CancelledError
        ) {
          return;
        }

        options.emit({ type: 'attemptFailed', error });
        options.publish({ type: 'attemptFailed', error });
      },
    }),
    retry({
      count: Math.max(0, options.retry.maxAttempts - 1),
      delay: (error, retryNumber) => {
        if (error instanceof IllegalTransitionError) return throwError(() => error);

        try {
          const decision = decideFailure(error, options.retry, retryNumber);

          if (decision.type === 'stop' || decision.type === 'giveUp')
            return throwError(() => error);

          options.emit({ type: 'retryScheduled' });
          options.publish({ type: 'retryScheduled', retryNumber, delayMs: decision.delayMs });

          return timer(decision.delayMs, options.scheduler);
        } catch (delayError) {
          return throwError(() => delayError);
        }
      },
    }),
    catchError((error) => {
      if (error instanceof IllegalTransitionError) return throwError(() => error);

      if (!(error instanceof CancelledError)) {
        options.emit({ type: 'cycleFailed', error });
        options.publish({ type: 'cycleFailed', error });
      } else {
        options.emit({ type: 'workCancelled' });
      }

      return EMPTY;
    }),
  );
}
