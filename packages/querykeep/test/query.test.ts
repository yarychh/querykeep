import { describe, expect, it } from 'bun:test';

import { BehaviorSubject, config, firstValueFrom, Subject } from 'rxjs';

import { AttemptTimeoutError, createQuery, createQueryClient } from '../src/index.js';
import type { QueryEvent } from '../src/index.js';
import { clock, deferred } from './harness.js';
import type { Clock } from './harness.js';

function setup<T>(
  time: Clock,
  queryFn: (context: { signal: AbortSignal }) => Promise<T>,
  extra: Parameters<typeof createQuery<T>>[0] = { queryFn },
) {
  return createQuery({
    scheduler: time.scheduler,
    now: time.now,
    elapsed: time.elapsed,
    intervalMs: false,
    timeoutMs: 5_000,
    admissionTimeoutMs: 5_000,
    retry: { maxAttempts: 1, delayMs: 20 },
    ...extra,
    queryFn,
  });
}

describe('query lifecycle', () => {
  it('starts once without subscribers and keeps running after they leave', async () => {
    const time = clock();
    let calls = 0;
    const query = setup(time, () => {
      calls += 1;

      return Promise.resolve('ok');
    });

    await time.to(0);
    expect(calls).toBe(1);
    expect(query.state().snapshot?.data).toBe('ok');
    const view = query.select((state) => state.snapshot?.data);
    const sub = view.subscribe();

    sub.unsubscribe();
    query.refresh();
    await time.settle();
    expect(calls).toBe(2);
  });

  it('shares one execution across state subscribers', async () => {
    const time = clock();
    let calls = 0;
    const query = setup(time, () => {
      calls += 1;

      return Promise.resolve(1);
    });

    query.state$.subscribe();
    query.state$.subscribe();
    await time.to(0);
    expect(calls).toBe(1);
  });

  it('runs once when intervalMs is false, then only on refresh', async () => {
    const time = clock();
    let calls = 0;
    const query = setup(time, () => {
      calls += 1;

      return Promise.resolve(calls);
    });

    await time.to(0);
    await time.to(10_000);
    expect(calls).toBe(1);
    query.refresh();
    await time.settle();
    expect(calls).toBe(2);
    expect(query.state().snapshot?.data).toBe(2);
  });

  it('skips overlapping triggers and does not replay ticks missed while paused', async () => {
    const time = clock();
    const pending = deferred<string>();
    let calls = 0;
    const events: QueryEvent<string>[] = [];
    const query = setup(
      time,
      () => {
        calls += 1;

        return calls === 1 ? pending.promise : Promise.resolve('next');
      },
      { queryFn: () => Promise.resolve(''), intervalMs: 100 },
    );

    query.events$.subscribe((event) => events.push(event));
    time.flushSync(0);
    expect(query.state().phase).toBe('fetching');
    time.flushSync(300);
    expect(calls).toBe(1);
    expect(events.filter((event) => event.type === 'triggerSkipped').length).toBeGreaterThanOrEqual(
      1,
    );
    pending.resolve('first');
    await time.settle();
    expect(query.state().snapshot?.data).toBe('first');
    query.pause();
    time.flushSync(1_000);
    expect(calls).toBe(1);
    query.resume();
    await time.to(time.scheduler.now());
    expect(calls).toBe(2);
    await time.to(time.scheduler.now() + 100);
    expect(calls).toBe(3);
  });

  it('drops refresh and refreshOn emissions while paused or busy', async () => {
    const time = clock();
    const refreshOn$ = new Subject<void>();
    const pending = deferred<number>();
    let calls = 0;
    const events: string[] = [];
    const query = setup(
      time,
      () => {
        calls += 1;

        return pending.promise;
      },
      { queryFn: () => Promise.resolve(0), refreshOn$ },
    );

    query.events$.subscribe((event) => events.push(event.type));
    time.flushSync(0);
    refreshOn$.next();
    query.refresh();
    expect(calls).toBe(1);
    expect(events.filter((type) => type === 'triggerSkipped').length).toBe(2);
    query.pause();
    const skipped = events.length;

    query.refresh();
    refreshOn$.next();
    expect(events.slice(skipped)).toEqual(['triggerSkipped', 'triggerSkipped']);
    pending.resolve(1);
    await time.settle();
    expect(query.state().snapshot).toBeUndefined();
    query.resume();
    await time.to(time.scheduler.now());
    expect(calls).toBe(2);
  });

  it('keeps polling after refreshOn$ completes', async () => {
    const time = clock();
    const refreshOn$ = new Subject<void>();
    let calls = 0;
    const query = setup(
      time,
      () => {
        calls += 1;

        return Promise.resolve(calls);
      },
      { queryFn: () => Promise.resolve(0), intervalMs: 100, refreshOn$ },
    );

    await time.to(0);
    refreshOn$.complete();
    let completed = false;

    query.state$.subscribe({ complete: () => (completed = true) });
    await time.to(100);
    expect(completed).toBe(false);
    expect(query.state().disposed).toBe(false);
    expect(calls).toBe(2);
  });

  it('keeps polling after refreshOn$ errors and isolates the failure', async () => {
    const time = clock();
    const refreshOn$ = new Subject<number>();
    let calls = 0;
    const events: QueryEvent<number>[] = [];
    const query = setup(
      time,
      () => {
        calls += 1;

        return Promise.resolve(calls);
      },
      { queryFn: () => Promise.resolve(0), intervalMs: 100, refreshOn$ },
    );

    query.events$.subscribe((event) => events.push(event));
    await time.to(0);
    refreshOn$.error(new Error('trigger broke'));
    expect(query.state().error).toEqual(new Error('trigger broke'));
    expect(query.state().snapshot?.data).toBe(1);
    expect(events.some((event) => event.type === 'triggerError')).toBe(true);
    let completed = false;

    query.state$.subscribe({ complete: () => (completed = true) });
    await time.to(100);
    expect(completed).toBe(false);
    expect(calls).toBe(2);
    expect(query.state().error).toBeUndefined();
  });

  it('ignores the value already present on refreshOn$ at creation', async () => {
    const time = clock();
    const refreshOn$ = new BehaviorSubject<number>(1);
    const events: string[] = [];
    let calls = 0;
    const query = setup(
      time,
      () => {
        calls += 1;

        return Promise.resolve(calls);
      },
      { queryFn: () => Promise.resolve(0), refreshOn$ },
    );

    query.events$.subscribe((event) => events.push(event.type));
    await time.to(0);
    expect(calls).toBe(1);
    expect(events.includes('triggerSkipped')).toBe(false);
    refreshOn$.next(2);
    await time.settle();
    expect(calls).toBe(2);
    expect(events.includes('attemptStarted')).toBe(true);
  });

  it('treats a synchronous enabled$ false as closed and does not let true clear pause', async () => {
    const time = clock();
    const enabled$ = new BehaviorSubject(false);
    let calls = 0;
    const blocked = setup(
      time,
      () => {
        calls += 1;

        return Promise.resolve(1);
      },
      { queryFn: () => Promise.resolve(1), enabled$ },
    );

    await time.to(0);
    expect(calls).toBe(0);
    expect(blocked.state().blocked).toBe(true);
    expect(blocked.state().paused).toBe(false);
    enabled$.next(true);
    await time.to(time.scheduler.now());
    expect(calls).toBe(1);

    const manual = new BehaviorSubject(true);
    let later = 0;
    const paused = setup(
      time,
      () => {
        later += 1;

        return Promise.resolve(1);
      },
      { queryFn: () => Promise.resolve(1), enabled: false, enabled$: manual },
    );

    await time.to(time.scheduler.now());
    manual.next(true);
    expect(later).toBe(0);
    expect(paused.state().paused).toBe(true);
    paused.resume();
    await time.to(time.scheduler.now());
    expect(later).toBe(1);
  });

  it('keeps the last gate when enabled$ errors, and blocks an open gate without clearing pause', async () => {
    const time = clock();
    const enabled$ = new Subject<boolean>();
    let calls = 0;
    const query = setup(
      time,
      () => {
        calls += 1;

        return Promise.resolve('ok');
      },
      { queryFn: () => Promise.resolve('ok'), intervalMs: 100, enabled$ },
    );

    await time.to(0);
    enabled$.error(new Error('gate'));
    expect(query.state().blocked).toBe(false);
    expect(query.state().error).toEqual(new Error('gate'));
    await time.to(100);
    expect(calls).toBe(2);

    const gate = new BehaviorSubject(true);
    const pending = deferred<string>();
    const gated = setup(time, () => pending.promise, {
      queryFn: () => Promise.resolve(''),
      enabled$: gate,
    });

    time.flushSync(time.scheduler.now());
    expect(gated.state().phase).toBe('fetching');
    gate.next(false);
    expect(gated.state().blocked).toBe(true);
    expect(gated.state().phase).toBe('idle');
    pending.resolve('late');
    await time.settle();
    expect(gated.state().snapshot).toBeUndefined();
  });

  it.each([
    [1, 1, 0],
    [2, 2, 1],
    [3, 3, 2],
  ])('retries until maxAttempts %i (%i calls, %i delays)', async (maxAttempts, calls, delays) => {
    const time = clock();
    const retryNumbers: number[] = [];
    let seen = 0;
    const query = setup(
      time,
      () => {
        seen += 1;

        return Promise.reject(new Error('no'));
      },
      {
        queryFn: () => Promise.resolve(0),
        retry: {
          maxAttempts,
          delayMs: ({ retryNumber }) => {
            retryNumbers.push(retryNumber);

            return 10;
          },
        },
      },
    );

    await time.to(0);

    for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
      await time.to(time.scheduler.now() + 10);
    }

    expect(seen).toBe(calls);
    expect(retryNumbers).toEqual(Array.from({ length: delays }, (_, index) => index + 1));
    expect(query.state().phase).toBe('idle');
    expect(query.state().error).toEqual(new Error('no'));
  });

  it.each([
    ['retryable failure keeps the snapshot and enters backoff', 'backoff'],
    ['the next attempt keeps that error until success clears it', 'keeps'],
    ['exhausted retries finish idle with the error and the old snapshot', 'exhausted'],
    ['shouldRetry false finishes idle with the error', 'predicate'],
    ['pause does not replace the existing error', 'pause'],
    ['dispose does not replace the existing error', 'dispose'],
  ] as const)('%s', async (_name, kind) => {
    const time = clock();
    const initial = { data: 'kept', receivedAt: 50 };
    let calls = 0;
    const fail = kind === 'keeps' ? 1 : Number.POSITIVE_INFINITY;
    const query = setup(
      time,
      () => {
        calls += 1;

        if (calls <= fail) return Promise.reject(new Error(`fail-${calls}`));

        return Promise.resolve('kept');
      },
      {
        queryFn: () => Promise.resolve(''),
        initialSnapshot: initial,
        retry: {
          maxAttempts: kind === 'exhausted' || kind === 'pause' || kind === 'dispose' ? 1 : 3,
          delayMs: 15,
          shouldRetry: kind === 'predicate' ? () => false : undefined,
        },
      },
    );

    await time.to(0);

    if (kind === 'backoff') {
      expect(query.state().phase).toBe('backoff');
      expect(query.state().error).toEqual(new Error('fail-1'));
      expect(query.state().snapshot).toEqual(initial);

      return;
    }

    if (kind === 'keeps') {
      time.flushSync(time.scheduler.now() + 15);
      expect(query.state().phase).toBe('fetching');
      expect(query.state().error).toEqual(new Error('fail-1'));
      expect(query.state().snapshot).toEqual(initial);
      await time.settle();
      expect(query.state().error).toBeUndefined();
      expect(query.state().snapshot?.data).toBe('kept');
      expect(query.state().snapshot?.receivedAt).toBe(5_000);

      return;
    }

    expect(query.state().phase).toBe('idle');
    expect(query.state().error).toEqual(new Error('fail-1'));
    expect(query.state().snapshot).toEqual(initial);

    if (kind === 'predicate') expect(calls).toBe(1);

    if (kind === 'pause') {
      query.pause();
      await time.to(time.scheduler.now() + 100);
      expect(calls).toBe(1);
      expect(query.state().phase).toBe('idle');
      expect(query.state().error).toEqual(new Error('fail-1'));
    }

    if (kind === 'dispose') {
      query.dispose();
      expect(query.state().disposed).toBe(true);
      expect(query.state().error).toEqual(new Error('fail-1'));
      await time.to(time.scheduler.now() + 100);
      expect(calls).toBe(1);
    }
  });

  it('recovers on a later tick after retries are exhausted', async () => {
    const time = clock();
    let calls = 0;
    const query = setup(
      time,
      () => {
        calls += 1;

        return calls === 1 ? Promise.reject(new Error('down')) : Promise.resolve('up');
      },
      {
        queryFn: () => Promise.resolve(''),
        intervalMs: 100,
        retry: { maxAttempts: 1, delayMs: 1 },
      },
    );

    await time.to(0);
    expect(query.state()).toMatchObject({
      phase: 'idle',
      error: new Error('down'),
    });
    await time.to(100);
    expect(calls).toBe(2);
    expect(query.state().error).toBeUndefined();
    expect(query.state().snapshot?.data).toBe('up');
  });

  it('counts a synchronous throw as an attempt and retries it', async () => {
    const time = clock();
    let calls = 0;
    const query = setup(
      time,
      () => {
        calls += 1;

        if (calls === 1) throw new Error('sync');

        return Promise.resolve('ok');
      },
      {
        queryFn: () => Promise.resolve(''),
        retry: { maxAttempts: 2, delayMs: 10 },
      },
    );

    time.flushSync(0);
    expect(query.state().phase).toBe('backoff');
    expect(query.state().error).toEqual(new Error('sync'));
    await time.to(10);
    expect(calls).toBe(2);
    expect(query.state().snapshot?.data).toBe('ok');
  });

  it('replays the latest snapshot, including the restored one, and advances receivedAt', async () => {
    const time = clock();

    time.at(80);
    const restored = { data: 'same', receivedAt: 50 };
    const seen: Array<{ data: string; receivedAt: number }> = [];
    const query = setup(time, () => Promise.resolve('same'), {
      queryFn: () => Promise.resolve('same'),
      initialSnapshot: restored,
    });

    query.snapshots$.subscribe((snapshot) => seen.push(snapshot));
    expect(seen).toEqual([restored]);
    await time.to(0);
    expect(query.state().snapshot).toEqual({ data: 'same', receivedAt: 80 });
    expect(seen.map((snapshot) => snapshot.receivedAt)).toEqual([50, 80]);
    const late: unknown[] = [];

    query.snapshots$.subscribe((snapshot) => late.push(snapshot));
    expect(late).toEqual([{ data: 'same', receivedAt: 80 }]);
  });

  it('shares one select projection, keeps undefined, and leaves execution running', async () => {
    const time = clock();
    let calls = 0;
    let projections = 0;
    const query = setup(
      time,
      () => {
        calls += 1;

        return Promise.resolve(undefined);
      },
      {
        queryFn: () => Promise.resolve(undefined),
        initialSnapshot: { data: 1, receivedAt: 1 },
      },
    );
    const view = query.select((state) => {
      projections += 1;

      return state.snapshot?.data;
    });
    const first: unknown[] = [];
    const second: unknown[] = [];
    let states = 0;

    view.subscribe((value) => first.push(value));
    view.subscribe((value) => second.push(value));
    query.state$.subscribe(() => {
      states += 1;
    });
    expect(first).toEqual([1]);
    expect(second).toEqual([1]);
    expect(projections).toBe(1);
    const projectedAtStart = projections;
    const statesAtStart = states;

    await time.to(0);
    expect(calls).toBe(1);
    expect(first).toEqual([1, undefined]);
    expect(second).toEqual([1, undefined]);
    expect(projections - projectedAtStart).toBe(states - statesAtStart);
    const again = query.select((state) => state.phase);
    const phases: string[] = [];

    again.subscribe((phase) => phases.push(phase));
    expect(phases).toEqual(['idle']);
    expect(await firstValueFrom(query.select((state) => state.snapshot?.data))).toBeUndefined();
  });

  it('does not replay events and completes them on dispose', async () => {
    const time = clock();
    const early: string[] = [];
    const query = setup(time, () => Promise.resolve('ok'));

    await time.to(0);
    query.events$.subscribe((event) => early.push(event.type));
    expect(early).toEqual([]);
    let completed = false;

    query.events$.subscribe({ complete: () => (completed = true) });
    query.refresh();
    await time.settle();
    expect(early).toEqual(['attemptStarted', 'succeeded']);
    query.dispose();
    expect(completed).toBe(true);
    expect(query.state().disposed).toBe(true);
  });

  it('defers dispose requested from a state subscriber', async () => {
    const time = clock();
    const query = setup(time, () => Promise.resolve(1));
    let sawComplete = false;
    let disarmed = false;

    query.state$.subscribe({
      next() {
        if (disarmed) return;

        disarmed = true;
        query.dispose();
        expect(query.state().disposed).toBe(false);
        expect(sawComplete).toBe(false);
      },
      complete() {
        sawComplete = true;
      },
    });
    expect(query.state().disposed).toBe(false);
    await time.settle();
    expect(query.state().disposed).toBe(true);
    expect(sawComplete).toBe(true);
  });

  it.each([
    ['pause', 'paused'],
    ['refresh', 'refresh'],
  ] as const)('defers %s requested from a state subscriber', async (_name, kind) => {
    const time = clock();
    const pending = deferred<number>();
    let calls = 0;
    const query = setup(time, () => {
      calls += 1;

      return pending.promise;
    });
    let callsDuringNotify = -1;
    let pausedDuringNotify = true;

    query.state$.subscribe(() => {
      callsDuringNotify = calls;
      pausedDuringNotify = query.state().paused;

      if (kind === 'paused') query.pause();
      else query.refresh();
    });
    expect(callsDuringNotify).toBe(0);
    expect(pausedDuringNotify).toBe(false);
    expect(query.state().paused).toBe(false);
    expect(calls).toBe(0);
    await time.settle();

    if (kind === 'paused') {
      expect(query.state().paused).toBe(true);
      expect(calls).toBe(0);

      return;
    }

    expect(calls).toBe(1);
    expect(query.state().phase).toBe('fetching');
  });

  it('returns a shallow state copy that shares the payload reference', async () => {
    const time = clock();
    const payload = { n: 1 };
    const query = setup(time, () => Promise.resolve(payload));
    const delivered: Array<ReturnType<typeof query.state>> = [];

    query.state$.subscribe((state) => delivered.push(state));
    await time.to(0);
    const first = query.state();
    const second = query.state();
    const fromStream = delivered.at(-1)!;

    expect(first).not.toBe(second);
    expect(first).not.toBe(fromStream);
    expect(first.snapshot).not.toBe(second.snapshot);
    expect(first.snapshot).not.toBe(fromStream.snapshot);
    expect(first.snapshot?.data).toBe(payload);
    expect(fromStream.snapshot?.data).toBe(payload);

    (first as { paused: boolean }).paused = true;
    (first as { phase: string }).phase = 'fetching';

    if (first.snapshot) (first.snapshot as { receivedAt: number }).receivedAt = 1;

    (fromStream as { paused: boolean }).paused = true;
    (fromStream as { phase: string }).phase = 'backoff';

    if (fromStream.snapshot) (fromStream.snapshot as { receivedAt: number }).receivedAt = 2;

    const replayed: Array<{ receivedAt: number }> = [];

    query.snapshots$.subscribe((snapshot) => replayed.push(snapshot));

    if (replayed[0]) (replayed[0] as { receivedAt: number }).receivedAt = 3;

    expect(query.state().paused).toBe(false);
    expect(query.state().phase).toBe('idle');
    expect(query.state().snapshot?.receivedAt).toBe(5_000);
    expect(query.state().snapshot?.data).toBe(payload);

    time.at(9_000);
    query.refresh();
    await time.settle();
    expect(query.state().paused).toBe(false);
    expect(query.state().phase).toBe('idle');
    expect(query.state().snapshot?.data).toBe(payload);
    expect(query.state().snapshot?.receivedAt).toBe(9_000);
  });

  it('does not let a throwing state subscriber consume an attempt or stop other subscribers', async () => {
    const time = clock();
    let calls = 0;
    const query = setup(
      time,
      () => {
        calls += 1;

        return Promise.resolve(calls);
      },
      {
        queryFn: () => Promise.resolve(0),
        retry: { maxAttempts: 3, delayMs: 1 },
      },
    );
    const seen: number[] = [];
    let streamError = false;
    const reports: unknown[] = [];
    const previous = config.onUnhandledError;

    config.onUnhandledError = (error) => {
      reports.push(error);
    };

    try {
      query.state$.subscribe(() => {
        throw new Error('render failed');
      });
      query.state$.subscribe({
        next: (state) => {
          if (state.snapshot) seen.push(state.snapshot.data);
        },
        error: () => {
          streamError = true;
        },
      });
      await time.to(0);
      await time.to(10);
      expect(calls).toBe(1);
      expect(seen).toEqual([1]);
      expect(streamError).toBe(false);
      expect(query.state().error).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(reports.length).toBeGreaterThanOrEqual(1);
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 20));
      config.onUnhandledError = previous;
    }
  });

  it('ignores late success and late rejection after the attempt times out', async () => {
    const time = clock();
    let rejectLate: (error: unknown) => void = () => {};
    const pending = new Promise<string>((_resolve, reject) => {
      rejectLate = reject;
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);

    process.on('unhandledRejection', onUnhandled);

    try {
      let calls = 0;
      const query = setup(
        time,
        () => {
          calls += 1;

          return pending;
        },
        {
          queryFn: () => Promise.resolve(''),
          timeoutMs: 25,
          retry: { maxAttempts: 1, delayMs: 10 },
        },
      );

      time.flushSync(0);
      expect(calls).toBe(1);
      await time.to(25);
      expect(query.state().error).toBeInstanceOf(AttemptTimeoutError);
      expect(query.state().phase).toBe('idle');
      rejectLate(new Error('later'));
      await time.settle();
      expect(query.state().snapshot).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      expect(query.state().error).toBeInstanceOf(AttemptTimeoutError);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('holds the physical slot until the timed-out promise settles', async () => {
    const time = clock();
    const pending = deferred<string>();
    let calls = 0;
    const query = setup(
      time,
      () => {
        calls += 1;

        return calls === 1 ? pending.promise : Promise.resolve('second');
      },
      {
        queryFn: () => Promise.resolve(''),
        timeoutMs: 20,
        admissionTimeoutMs: 5_000,
        retry: { maxAttempts: 2, delayMs: 0 },
      },
    );

    time.flushSync(0);
    await time.to(20);
    expect(calls).toBe(1);
    expect(query.state().phase).toBe('waiting');
    pending.resolve('ignored');
    await time.settle();
    expect(calls).toBe(2);
    expect(query.state().snapshot?.data).toBe('second');
  });

  it('does not let state$ fail when the source fails', async () => {
    const time = clock();
    let failed = false;
    let completed = false;
    const query = setup(time, () => Promise.reject(new Error('no')));

    query.state$.subscribe({
      error: () => (failed = true),
      complete: () => (completed = true),
    });
    await time.to(0);
    expect(failed).toBe(false);
    expect(completed).toBe(false);
    query.dispose();
    expect(completed).toBe(true);
  });
});

describe('client registry', () => {
  it('rejects duplicate and unknown keys, then allows the key after dispose', async () => {
    const time = clock();
    const client = createQueryClient({
      scheduler: time.scheduler,
      now: time.now,
      elapsed: time.elapsed,
      providers: { transport: { concurrency: 1, minIntervalMs: 0 } },
    });
    const first = client.query({
      key: [{ b: 1, a: 'stop' }],
      provider: 'transport',
      intervalMs: false,
      queryFn: () => Promise.resolve(1),
    });

    expect(() =>
      client.query({
        key: [{ a: 'stop', b: 1 }],
        provider: 'transport',
        queryFn: () => Promise.resolve(2),
      }),
    ).toThrow('Duplicate');
    expect(() =>
      client.query({
        key: ['other'],
        provider: 'missing',
        queryFn: () => Promise.resolve(0),
      }),
    ).toThrow('Unknown provider');
    first.dispose();
    const again = client.query({
      key: [{ a: 'stop', b: 1 }],
      provider: 'transport',
      intervalMs: false,
      queryFn: () => Promise.resolve(3),
    });

    await time.to(0);
    expect(again.state().snapshot?.data).toBe(3);
    client.dispose();
    expect(again.state().disposed).toBe(true);
    expect(() => client.query({ key: ['next'], queryFn: () => Promise.resolve(0) })).toThrow(
      'Client disposed',
    );
    expect(() => client.cooldown('transport', 10)).toThrow('Client disposed');
  });

  it('uses the documented retry defaults', async () => {
    const time = clock();
    let calls = 0;
    const query = createQuery({
      scheduler: time.scheduler,
      now: time.now,
      elapsed: time.elapsed,
      intervalMs: false,
      timeoutMs: 5_000,
      admissionTimeoutMs: 5_000,
      queryFn: () => {
        calls += 1;

        return Promise.reject(new Error('default'));
      },
    });

    await time.to(0);
    await time.to(1_000);
    await time.to(2_000);
    expect(calls).toBe(3);
    expect(query.state().phase).toBe('idle');
    await time.to(3_000);
    expect(calls).toBe(3);
  });

  it('keeps Date and Map payload references on the snapshot stream', async () => {
    const time = clock();
    const when = new Date(5);
    const bag = new Map([['a', 1]]);
    const payload = { when, bag };
    const seen: Array<{ when: Date; bag: Map<string, number> }> = [];
    const query = createQueryClient({
      scheduler: time.scheduler,
      now: time.now,
      elapsed: time.elapsed,
    }).query({
      key: ['payload'],
      intervalMs: false,
      queryFn: () => Promise.resolve(payload),
    });

    query.snapshots$.subscribe((snapshot) => seen.push(snapshot.data));
    await time.to(0);
    expect(query.state().snapshot?.data.when).toBe(when);
    expect(query.state().snapshot?.data.bag).toBe(bag);
    expect(seen.at(-1)?.when).toBe(when);
    expect(seen.at(-1)?.bag).toBe(bag);
  });

  it('keeps the previous error when dispose interrupts an in-flight attempt', async () => {
    const time = clock();
    const second = deferred<string>();
    let calls = 0;
    const client = createQueryClient({
      scheduler: time.scheduler,
      now: time.now,
      elapsed: time.elapsed,
    });
    const query = client.query({
      key: ['live'],
      intervalMs: false,
      timeoutMs: 5_000,
      admissionTimeoutMs: 5_000,
      retry: { maxAttempts: 2, delayMs: 10 },
      queryFn: () => {
        calls += 1;

        if (calls === 1) return Promise.reject(new Error('first'));

        return second.promise;
      },
    });

    await time.to(0);
    await time.to(10);
    expect(calls).toBe(2);
    expect(query.state().phase).toBe('fetching');
    expect(query.state().error).toEqual(new Error('first'));
    client.dispose();
    expect(query.state().disposed).toBe(true);
    expect(query.state().error).toEqual(new Error('first'));
    second.resolve('late');
    await time.settle();
    expect(query.state().snapshot).toBeUndefined();
    expect(calls).toBe(2);
    expect(() => client.query({ key: ['next'], queryFn: () => Promise.resolve(0) })).toThrow(
      'Client disposed',
    );
  });

  it('does not share permits or disposal across clients', async () => {
    const time = clock();
    const held = deferred<string>();
    const options = {
      scheduler: time.scheduler,
      now: time.now,
      elapsed: time.elapsed,
      concurrency: 1,
      defaults: {
        intervalMs: false as const,
        timeoutMs: 5_000,
        admissionTimeoutMs: 5_000,
        retry: { maxAttempts: 1, delayMs: 10 },
      },
    };
    const left = createQueryClient(options);
    const right = createQueryClient(options);
    let rightCalls = 0;

    left.query({
      key: ['shared'],
      queryFn: () => held.promise,
    });
    const other = right.query({
      key: ['shared'],
      queryFn: () => {
        rightCalls += 1;

        return Promise.resolve('right');
      },
    });

    await time.to(0);
    expect(rightCalls).toBe(1);
    expect(other.state().snapshot?.data).toBe('right');
    left.dispose();
    expect(other.state().disposed).toBe(false);
    expect(() =>
      right.query({
        key: ['shared'],
        queryFn: () => Promise.resolve('again'),
      }),
    ).toThrow('Duplicate');
    other.dispose();
    right.query({
      key: ['shared'],
      queryFn: () => Promise.resolve('again'),
    });
    held.resolve('left');
    await time.settle();
  });
});
