import type { Snapshot } from './state.js';

/** `busy` is a cycle already in progress. `cannotRun` is paused, blocked, or not executing. */
export type TriggerSkipReason = 'busy' | 'cannotRun';

/** Facts published on `events$`. State changes use `Transition` instead. */
export type QueryEvent<T> =
  | { readonly type: 'attemptStarted' }
  | { readonly type: 'attemptFailed'; readonly error: unknown }
  | { readonly type: 'retryScheduled'; readonly retryNumber: number; readonly delayMs: number }
  | { readonly type: 'succeeded'; readonly snapshot: Snapshot<T> }
  | { readonly type: 'cycleFailed'; readonly error: unknown }
  | { readonly type: 'triggerSkipped'; readonly reason: TriggerSkipReason }
  | { readonly type: 'triggerError'; readonly error: unknown };
