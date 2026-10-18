export interface QueryFnContext {
  readonly signal: AbortSignal;
}

export type QueryFn<T> = (context: QueryFnContext) => Promise<T>;

export class AttemptTimeoutError extends Error {
  constructor() {
    super('Attempt timed out');
    this.name = 'AttemptTimeoutError';
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

export function assertQueryFn(queryFn: unknown): void {
  if (typeof queryFn !== 'function') throw new Error('Invalid queryFn');
}
