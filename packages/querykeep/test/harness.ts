import { TestScheduler } from 'rxjs/testing';

export function microtask(): Promise<void> {
  return Promise.resolve()
    .then(() => Promise.resolve())
    .then(() => undefined);
}

export function clock() {
  const scheduler = new TestScheduler(() => undefined);

  scheduler.maxFrames = 0;
  let wall = 5_000;
  const now = () => wall;
  const elapsed = () => scheduler.now();
  const flushSync = (frame: number) => {
    if (frame < scheduler.frame) throw new Error(`cannot move from ${scheduler.frame} to ${frame}`);

    scheduler.maxFrames = frame;
    scheduler.flush();
  };

  return {
    scheduler,
    now,
    elapsed,
    at(time: number) {
      wall = time;
    },
    flushSync,
    async settle() {
      await microtask();
    },
    async to(frame: number) {
      flushSync(frame);
      await microtask();
    },
  };
}

export type Clock = ReturnType<typeof clock>;

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}
