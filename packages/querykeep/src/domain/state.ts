import { assertDuration } from './duration.js';

export interface Snapshot<T> {
  readonly data: T;
  readonly receivedAt: number;
}

export type Phase = 'idle' | 'waiting' | 'fetching' | 'backoff';

export interface QueryState<T> {
  readonly snapshot: Snapshot<T> | undefined;
  readonly error: unknown;
  readonly phase: Phase;
  readonly paused: boolean;
  readonly blocked: boolean;
  readonly disposed: boolean;
}

export type Transition<T> =
  | { readonly type: 'paused'; readonly paused: boolean }
  | { readonly type: 'blocked'; readonly blocked: boolean }
  | { readonly type: 'waiting' }
  | { readonly type: 'attemptStarted' }
  | { readonly type: 'attemptFailed'; readonly error: unknown }
  | { readonly type: 'retryScheduled' }
  | { readonly type: 'succeeded'; readonly snapshot: Snapshot<T> }
  | { readonly type: 'cycleFailed'; readonly error: unknown }
  | { readonly type: 'triggerError'; readonly error: unknown }
  | { readonly type: 'workCancelled' }
  | { readonly type: 'disposed' };

export class IllegalTransitionError extends Error {
  constructor(event: string, phase: Phase, disposed: boolean) {
    super(
      disposed
        ? `Illegal transition: ${event} while disposed`
        : `Illegal transition: ${event} from ${phase}`,
    );
    this.name = 'IllegalTransitionError';
  }
}

export function initialState<T>(paused: boolean, snapshot: Snapshot<T> | undefined): QueryState<T> {
  return {
    snapshot,
    error: undefined,
    phase: 'idle',
    paused,
    blocked: false,
    disposed: false,
  };
}

export function assertSnapshot<T>(snapshot: Snapshot<T> | undefined): Snapshot<T> | undefined {
  if (snapshot === undefined) return undefined;

  assertDuration(snapshot.receivedAt, 'initialSnapshot.receivedAt');

  return snapshot;
}

export function reduce<T>(state: QueryState<T>, event: Transition<T>): QueryState<T> {
  switch (event.type) {
    case 'paused':
      guard(state, event.type);

      return { ...state, paused: event.paused };
    case 'blocked':
      guard(state, event.type);

      return { ...state, blocked: event.blocked };
    case 'waiting':
      guard(state, event.type, ['idle', 'backoff']);

      return phase(state, 'waiting');
    case 'attemptStarted':
      guard(state, event.type, ['waiting']);

      return phase(state, 'fetching');
    case 'attemptFailed':
      guard(state, event.type, ['fetching']);

      return { ...state, error: event.error };
    case 'retryScheduled':
      guard(state, event.type, ['fetching']);

      return phase(state, 'backoff');
    case 'succeeded':
      guard(state, event.type, ['fetching']);

      return { ...state, phase: 'idle', error: undefined, snapshot: event.snapshot };
    case 'cycleFailed':
      guard(state, event.type, ['waiting', 'fetching']);

      return { ...state, phase: 'idle', error: event.error };
    case 'triggerError':
      guard(state, event.type);

      return { ...state, error: event.error };
    case 'workCancelled':
      guard(state, event.type);

      return state.phase === 'idle' ? state : { ...state, phase: 'idle' };
    case 'disposed':
      guard(state, event.type);

      return { ...state, disposed: true, phase: 'idle' };
  }
}

function guard<T>(state: QueryState<T>, event: string, allowed?: readonly Phase[]): void {
  if (!state.disposed && (allowed === undefined || allowed.includes(state.phase))) return;

  throw new IllegalTransitionError(event, state.phase, state.disposed);
}

function phase<T>(state: QueryState<T>, next: Phase): QueryState<T> {
  return state.phase === next ? state : { ...state, phase: next };
}
