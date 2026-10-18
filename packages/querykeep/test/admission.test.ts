import { describe, expect, it } from 'bun:test';

import {
  AdmissionClosedError,
  AdmissionOverflowError,
  AdmissionTimeoutError,
  createQueryClient,
} from '../src/index.js';
import type { ClientConfig } from '../src/index.js';
import { clock, deferred } from './harness.js';
import type { Clock } from './harness.js';

function clientFor(
  time: Clock,
  options: {
    concurrency?: number;
    maxQueued?: number;
    providers?: ClientConfig['providers'];
  } = {},
) {
  return createQueryClient({
    scheduler: time.scheduler,
    now: time.now,
    elapsed: time.elapsed,
    concurrency: options.concurrency ?? 4,
    maxQueued: options.maxQueued ?? 8,
    providers: options.providers,
    defaults: {
      intervalMs: false,
      timeoutMs: 5_000,
      admissionTimeoutMs: 5_000,
      retry: { maxAttempts: 1, delayMs: 10 },
    },
  });
}

describe('admission', () => {
  it.each([
    ['queue overflow', 'overflow'],
    ['admission timeout', 'timeout'],
  ] as const)('reports %s without consuming a source attempt', async (_name, kind) => {
    const time = clock();
    const held = deferred<string>();
    let shouldRetryCalls = 0;
    let overflowCalls = 0;
    const client = clientFor(time, {
      concurrency: 1,
      maxQueued: kind === 'overflow' ? 0 : 1,
    });

    client.query({
      key: ['holder'],
      queryFn: () => held.promise,
    });
    const blocked = client.query({
      key: ['blocked'],
      admissionTimeoutMs: kind === 'timeout' ? 40 : 5_000,
      retry: {
        maxAttempts: 3,
        delayMs: 10,
        shouldRetry: () => {
          shouldRetryCalls += 1;

          return true;
        },
      },
      queryFn: () => {
        overflowCalls += 1;

        return Promise.resolve('nope');
      },
    });

    await time.to(0);
    expect(overflowCalls).toBe(0);

    if (kind === 'overflow') {
      expect(blocked.state().error).toBeInstanceOf(AdmissionOverflowError);
      expect(blocked.state().phase).toBe('idle');
    } else {
      expect(blocked.state().phase).toBe('waiting');
      await time.to(40);
      expect(blocked.state().error).toBeInstanceOf(AdmissionTimeoutError);
      expect(blocked.state().phase).toBe('idle');
      expect(overflowCalls).toBe(0);
    }

    expect(shouldRetryCalls).toBe(0);
    held.resolve('done');
    await time.settle();
  });

  it('closes a queued wait with AdmissionClosedError and does not retry it', async () => {
    const time = clock();
    const held = deferred<string>();
    let shouldRetryCalls = 0;
    let waiterCalls = 0;
    const client = clientFor(time, { concurrency: 1, maxQueued: 2 });

    client.query({
      key: ['holder'],
      queryFn: () => held.promise,
    });
    const waiter = client.query({
      key: ['waiter'],
      retry: {
        maxAttempts: 3,
        delayMs: 10,
        shouldRetry: () => {
          shouldRetryCalls += 1;

          return true;
        },
      },
      queryFn: () => {
        waiterCalls += 1;

        return Promise.resolve('no');
      },
    });

    await time.to(0);
    expect(waiter.state().phase).toBe('waiting');
    client.dispose();
    expect(waiter.state().disposed).toBe(true);
    expect(waiter.state().error).toBeInstanceOf(AdmissionClosedError);
    expect(waiterCalls).toBe(0);
    expect(shouldRetryCalls).toBe(0);
    held.resolve('done');
    await time.settle();
    expect(waiterCalls).toBe(0);
    expect(() => client.query({ key: ['later'], queryFn: () => Promise.resolve(1) })).toThrow(
      'Client disposed',
    );
  });

  it('does not let a blocked provider hold back another provider', async () => {
    const time = clock();
    const held = deferred<string>();
    const calls = { a1: 0, a2: 0, b: 0 };
    const client = clientFor(time, {
      concurrency: 3,
      providers: {
        alpha: { concurrency: 1, minIntervalMs: 0 },
        beta: { concurrency: 1, minIntervalMs: 0 },
      },
    });

    client.query({
      key: ['a', 1],
      provider: 'alpha',
      queryFn: () => {
        calls.a1 += 1;

        return held.promise;
      },
    });
    client.query({
      key: ['a', 2],
      provider: 'alpha',
      queryFn: () => {
        calls.a2 += 1;

        return Promise.resolve('a2');
      },
    });
    client.query({
      key: ['b', 1],
      provider: 'beta',
      queryFn: () => {
        calls.b += 1;

        return Promise.resolve('b');
      },
    });
    await time.to(0);
    expect(calls).toEqual({ a1: 1, a2: 0, b: 1 });
    held.resolve('a1');
    await time.settle();
    expect(calls.a2).toBe(1);
  });

  it('grants a ready provider when ineligible tickets already fill the queue', async () => {
    const time = clock();
    const held = deferred<string>();
    const calls = { alphaHeld: 0, alphaQueued: 0, beta: 0 };
    const client = clientFor(time, {
      concurrency: 2,
      maxQueued: 1,
      providers: {
        alpha: { concurrency: 1, minIntervalMs: 0 },
        beta: { concurrency: 1, minIntervalMs: 0 },
      },
    });

    client.query({
      key: ['alpha', 'held'],
      provider: 'alpha',
      queryFn: () => {
        calls.alphaHeld += 1;

        return held.promise;
      },
    });
    const queued = client.query({
      key: ['alpha', 'queued'],
      provider: 'alpha',
      queryFn: () => {
        calls.alphaQueued += 1;

        return Promise.resolve('queued');
      },
    });

    client.query({
      key: ['beta', 'ready'],
      provider: 'beta',
      queryFn: () => {
        calls.beta += 1;

        return Promise.resolve('beta');
      },
    });
    await time.to(0);
    expect(calls).toEqual({ alphaHeld: 1, alphaQueued: 0, beta: 1 });
    expect(queued.state().phase).toBe('waiting');
    expect(queued.state().error).toBeUndefined();
    held.resolve('done');
    await time.settle();
    expect(calls.alphaQueued).toBe(1);
  });

  it('does not let a newcomer jump an earlier ready ticket when the queue is full', async () => {
    const time = clock();
    let elapsedMs = 0;
    const client = createQueryClient({
      scheduler: time.scheduler,
      now: time.now,
      elapsed: () => elapsedMs,
      concurrency: 2,
      maxQueued: 1,
      providers: {
        transport: { concurrency: 2, minIntervalMs: 50 },
      },
      defaults: {
        intervalMs: false,
        timeoutMs: 5_000,
        admissionTimeoutMs: 5_000,
        retry: { maxAttempts: 1, delayMs: 10 },
      },
    });
    const first = deferred<string>();

    client.query({
      key: ['transport', 1],
      provider: 'transport',
      queryFn: () => first.promise,
    });
    const queued = client.query({
      key: ['transport', 2],
      provider: 'transport',
      queryFn: () => Promise.resolve('queued'),
    });

    await time.to(0);
    expect(queued.state().phase).toBe('waiting');
    elapsedMs = 50;
    const late = client.query({
      key: ['transport', 3],
      provider: 'transport',
      queryFn: () => Promise.resolve('late'),
    });

    await time.to(0);
    expect(late.state().error).toBeInstanceOf(AdmissionOverflowError);
    expect(late.state().phase).toBe('idle');
    expect(queued.state().phase).toBe('waiting');
    expect(queued.state().error).toBeUndefined();
    first.resolve('done');
    await time.settle();
  });

  it('spaces provider starts and only extends cooldown', async () => {
    const time = clock();
    const calls = { a: 0, b: 0, other: 0 };
    const client = clientFor(time, {
      concurrency: 4,
      providers: {
        transport: { concurrency: 2, minIntervalMs: 50 },
        other: { concurrency: 2, minIntervalMs: 0 },
      },
    });

    client.query({
      key: ['a'],
      provider: 'transport',
      queryFn: () => {
        calls.a += 1;
        client.cooldown('transport', 200);

        return Promise.resolve('a');
      },
    });
    client.query({
      key: ['b'],
      provider: 'transport',
      queryFn: () => {
        calls.b += 1;

        return Promise.resolve('b');
      },
    });
    client.query({
      key: ['c'],
      provider: 'other',
      queryFn: () => {
        calls.other += 1;

        return Promise.resolve('c');
      },
    });
    await time.to(0);
    expect(calls).toEqual({ a: 1, b: 0, other: 1 });
    await time.to(50);
    expect(calls.b).toBe(0);
    await time.to(200);
    expect(calls.b).toBe(1);
  });

  it('removes a paused waiter so a later query can use the freed slot', async () => {
    const time = clock();
    const held = deferred<string>();
    let waiterCalls = 0;
    let nextCalls = 0;
    const client = clientFor(time, { concurrency: 1, maxQueued: 2 });

    client.query({ key: ['hold'], queryFn: () => held.promise });
    const waiter = client.query({
      key: ['wait'],
      queryFn: () => {
        waiterCalls += 1;

        return Promise.resolve('wait');
      },
    });

    time.flushSync(0);
    expect(waiter.state().phase).toBe('waiting');
    waiter.pause();
    expect(waiter.state().phase).toBe('idle');
    expect(waiter.state().error).toBeUndefined();
    held.resolve('done');
    await time.settle();
    const next = client.query({
      key: ['next'],
      queryFn: () => {
        nextCalls += 1;

        return Promise.resolve('next');
      },
    });

    await time.to(time.scheduler.now());
    expect(waiterCalls).toBe(0);
    expect(nextCalls).toBe(1);
    expect(next.state().snapshot?.data).toBe('next');
  });

  it('keeps the attempt timeout from starting until admission grants the slot', async () => {
    const time = clock();
    const held = deferred<string>();
    let calls = 0;
    const client = clientFor(time, { concurrency: 1, maxQueued: 1 });

    client.query({
      key: ['hold'],
      timeoutMs: 10_000,
      queryFn: () => held.promise,
    });
    const waiting = client.query({
      key: ['wait'],
      timeoutMs: 15,
      admissionTimeoutMs: 80,
      queryFn: () => {
        calls += 1;

        return Promise.resolve('late');
      },
    });

    await time.to(0);
    await time.to(15);
    expect(waiting.state().phase).toBe('waiting');
    expect(calls).toBe(0);
    await time.to(80);
    expect(waiting.state().error).toBeInstanceOf(AdmissionTimeoutError);
    expect(calls).toBe(0);
    held.resolve('done');
    await time.settle();
  });

  it('does not leak a permit after cancellation', async () => {
    const time = clock();
    const first = deferred<string>();
    let calls = 0;
    const client = clientFor(time, { concurrency: 1, maxQueued: 1 });
    const running = client.query({
      key: ['run'],
      queryFn: () => first.promise,
    });

    time.flushSync(0);
    expect(running.state().phase).toBe('fetching');
    running.dispose();
    expect(running.state().error).toBeUndefined();
    first.resolve('ignored');
    await time.settle();
    const follow = client.query({
      key: ['follow'],
      queryFn: () => {
        calls += 1;

        return Promise.resolve('ok');
      },
    });

    await time.to(time.scheduler.now());
    expect(calls).toBe(1);
    expect(follow.state().snapshot?.data).toBe('ok');
  });

  it('drops the pacing wake when the queue is empty and keeps the provider delay', async () => {
    const time = clock();
    let calls = 0;
    const client = clientFor(time, {
      concurrency: 2,
      providers: { transport: { concurrency: 2, minIntervalMs: 100 } },
    });

    client.query({
      key: ['first'],
      provider: 'transport',
      queryFn: () => Promise.resolve('first'),
    });
    await time.to(0);
    const waiter = client.query({
      key: ['waiter'],
      provider: 'transport',
      queryFn: () => {
        calls += 1;

        return Promise.resolve('waiter');
      },
    });

    time.flushSync(0);
    expect(waiter.state().phase).toBe('waiting');
    expect(calls).toBe(0);
    expect(time.scheduler.actions.length).toBeGreaterThanOrEqual(1);
    waiter.dispose();
    await time.settle();
    expect(time.scheduler.actions.length).toBe(0);

    client.cooldown('transport', 180);
    const next = client.query({
      key: ['next'],
      provider: 'transport',
      queryFn: () => {
        calls += 1;

        return Promise.resolve('next');
      },
    });

    await time.to(100);
    expect(calls).toBe(0);
    expect(next.state().phase).toBe('waiting');
    await time.to(180);
    expect(calls).toBe(1);
    expect(next.state().snapshot?.data).toBe('next');
  });
});
