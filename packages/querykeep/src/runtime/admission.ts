import { Observable, timer } from 'rxjs';
import type { SchedulerLike, Subscription } from 'rxjs';

import {
  AdmissionClosedError,
  AdmissionOverflowError,
  AdmissionTimeoutError,
  eligibility,
} from '../domain/admission.js';
import type { AdmissionBlock, ProviderLimits } from '../domain/admission.js';
import { CancelledError } from '../domain/attempt.js';

export interface Permit {
  release(): void;
}

export interface Admission {
  acquire(input: {
    readonly key: string;
    readonly provider?: string;
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
  }): Observable<Permit>;
  cooldown(provider: string, delayMs: number): void;
  close(): void;
}

interface Ticket {
  readonly key: string;
  readonly provider?: string;
  granted: boolean;
  settled: boolean;
  timeoutSub?: Subscription;
  deliver: (permit: Permit) => void;
  fail: (error: unknown) => void;
}

/**
 * Eligibility-ordered FIFO. A ticket blocked by its provider or its own in-flight
 * invocation does not hold back other keys. The permit stays out until the source
 * promise settles, even if the attempt observable has already unsubscribed.
 */
export function createAdmission(options: {
  readonly concurrency: number;
  readonly maxQueued: number;
  readonly providers: ReadonlyMap<string, ProviderLimits>;
  readonly elapsed: () => number;
  readonly scheduler: SchedulerLike;
}): Admission {
  const queue: Ticket[] = [];
  const heldKeys = new Set<string>();
  const providerActive = new Map<string, number>();
  const providerNotBefore = new Map<string, number>();
  let active = 0;
  let closed = false;
  let pumping = false;
  let pumpAgain = false;
  let wakeSub: Subscription | undefined;

  function notBefore(provider: string | undefined): number {
    return provider === undefined ? 0 : (providerNotBefore.get(provider) ?? 0);
  }

  function classify(ticket: Ticket): AdmissionBlock {
    const provider = ticket.provider;

    return eligibility({
      held: heldKeys.has(ticket.key),
      provider,
      providerActive: provider === undefined ? 0 : (providerActive.get(provider) ?? 0),
      providerConcurrency:
        provider === undefined ? undefined : options.providers.get(provider)?.concurrency,
      elapsed: options.elapsed(),
      notBefore: notBefore(provider),
      active,
      concurrency: options.concurrency,
    });
  }

  function account(ticket: Ticket): void {
    active += 1;
    heldKeys.add(ticket.key);

    if (ticket.provider === undefined) return;

    providerActive.set(ticket.provider, (providerActive.get(ticket.provider) ?? 0) + 1);
    const spacing = options.providers.get(ticket.provider)?.minIntervalMs ?? 0;
    const next = options.elapsed() + spacing;

    providerNotBefore.set(ticket.provider, Math.max(notBefore(ticket.provider), next));
  }

  function releaseTicket(ticket: Ticket): void {
    active -= 1;
    heldKeys.delete(ticket.key);

    if (ticket.provider !== undefined) {
      providerActive.set(
        ticket.provider,
        Math.max(0, (providerActive.get(ticket.provider) ?? 1) - 1),
      );
    }

    pump();
  }

  function makePermit(ticket: Ticket): Permit {
    let released = false;

    return {
      release() {
        if (released) return;

        released = true;
        releaseTicket(ticket);
      },
    };
  }

  function remove(ticket: Ticket): void {
    const index = queue.indexOf(ticket);

    if (index >= 0) queue.splice(index, 1);

    if (queue.length === 0) {
      wakeSub?.unsubscribe();
      wakeSub = undefined;
    }
  }

  function grant(ticket: Ticket): void {
    if (ticket.settled || ticket.granted) return;

    ticket.granted = true;
    ticket.timeoutSub?.unsubscribe();
    account(ticket);
    ticket.deliver(makePermit(ticket));
  }

  function drain(): void {
    wakeSub?.unsubscribe();
    wakeSub = undefined;

    if (closed) return;

    let earliest = Infinity;
    let index = 0;

    while (index < queue.length && active < options.concurrency) {
      const ticket = queue[index]!;
      const reason = classify(ticket);

      if (reason === 'wait') {
        earliest = Math.min(earliest, notBefore(ticket.provider));
        index += 1;
        continue;
      }

      if (reason === 'blocked') {
        index += 1;
        continue;
      }

      queue.splice(index, 1);
      grant(ticket);
    }

    if (earliest < Infinity && active < options.concurrency) {
      const wait = Math.max(0, earliest - options.elapsed());

      wakeSub = timer(wait, options.scheduler).subscribe(() => pump());
    }
  }

  function pump(): void {
    if (pumping) {
      pumpAgain = true;

      return;
    }

    pumping = true;

    try {
      do {
        pumpAgain = false;
        drain();
      } while (pumpAgain);
    } finally {
      pumping = false;
    }
  }

  return {
    acquire({ key, provider, signal, timeoutMs }) {
      return new Observable((subscriber) => {
        if (closed) {
          subscriber.error(new AdmissionClosedError());

          return;
        }

        if (signal.aborted) {
          subscriber.error(new CancelledError());

          return;
        }

        let open = true;
        const ticket: Ticket = {
          key,
          provider,
          granted: false,
          settled: false,
          deliver: () => {},
          fail: () => {},
        };

        const stopListening = () => signal.removeEventListener('abort', onAbort);
        const fail = (error: unknown) => {
          if (!open || ticket.granted || ticket.settled) return;

          open = false;
          ticket.settled = true;
          ticket.timeoutSub?.unsubscribe();
          remove(ticket);
          stopListening();

          if (!subscriber.closed) subscriber.error(error);
        };
        const onAbort = () => fail(new CancelledError());

        ticket.fail = fail;
        ticket.deliver = (permit) => {
          if (!open || ticket.settled) {
            permit.release();

            return;
          }

          subscriber.next(permit);

          if (!subscriber.closed) subscriber.complete();
        };
        signal.addEventListener('abort', onAbort);

        const teardown = () => {
          open = false;
          ticket.timeoutSub?.unsubscribe();
          stopListening();

          if (!ticket.granted && !ticket.settled) {
            ticket.settled = true;
            remove(ticket);
          }
        };

        const earlierReady = queue.some((queued) => classify(queued) === 'ready');

        // A ready ticket does not take a queue slot, and it does not jump one that is already eligible.
        if (!earlierReady && classify(ticket) === 'ready') {
          grant(ticket);

          return teardown;
        }

        if (queue.length >= options.maxQueued) {
          stopListening();
          subscriber.error(new AdmissionOverflowError());

          return;
        }

        queue.push(ticket);
        ticket.timeoutSub = timer(timeoutMs, options.scheduler).subscribe(() => {
          fail(new AdmissionTimeoutError());
          pump();
        });
        pump();

        return teardown;
      });
    },
    cooldown(provider, delayMs) {
      const next = options.elapsed() + delayMs;

      providerNotBefore.set(provider, Math.max(notBefore(provider), next));
      pump();
    },
    close() {
      closed = true;
      wakeSub?.unsubscribe();
      wakeSub = undefined;

      for (const ticket of queue.splice(0)) ticket.fail(new AdmissionClosedError());
    },
  };
}
