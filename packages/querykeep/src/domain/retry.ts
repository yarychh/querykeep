import { isAdmissionError } from './admission.js';
import { CancelledError } from './attempt.js';
import { assertDuration, assertPositiveInteger } from './duration.js';

export interface RetryDelayContext {
  readonly retryNumber: number;
}

export type DelayMs = number | ((context: RetryDelayContext) => number);

export interface RetryConfig {
  readonly maxAttempts?: number;
  readonly delayMs?: DelayMs;
  readonly shouldRetry?: (error: unknown) => boolean;
}

export interface ResolvedRetry {
  readonly maxAttempts: number;
  readonly delayMs: DelayMs;
  readonly shouldRetry?: (error: unknown) => boolean;
}

export type FailureDecision =
  | { readonly type: 'stop' }
  | { readonly type: 'giveUp' }
  | { readonly type: 'retry'; readonly delayMs: number };

export function resolveRetry(input: RetryConfig | undefined, base?: ResolvedRetry): ResolvedRetry {
  const retry: ResolvedRetry = {
    maxAttempts: input?.maxAttempts ?? base?.maxAttempts ?? 3,
    delayMs: input?.delayMs ?? base?.delayMs ?? 1_000,
    shouldRetry: input?.shouldRetry ?? base?.shouldRetry,
  };

  assertPositiveInteger(retry.maxAttempts, 'retry.maxAttempts');

  if (typeof retry.delayMs === 'number') assertDuration(retry.delayMs, 'retry.delayMs');
  else if (typeof retry.delayMs !== 'function') throw new Error('Invalid retry.delayMs');

  return retry;
}

export function resolveDelay(delayMs: DelayMs, retryNumber: number): number {
  const value = typeof delayMs === 'function' ? delayMs({ retryNumber }) : delayMs;

  return assertDuration(value, 'retry.delayMs');
}

export function decideFailure(
  error: unknown,
  retry: ResolvedRetry,
  retryNumber: number,
): FailureDecision {
  if (isAdmissionError(error) || error instanceof CancelledError) return { type: 'stop' };

  if (retry.shouldRetry && !retry.shouldRetry(error)) return { type: 'giveUp' };

  return { type: 'retry', delayMs: resolveDelay(retry.delayMs, retryNumber) };
}

export function exponentialBackoff(options: {
  readonly baseMs: number;
  readonly capMs: number;
  readonly jitter: 'full' | 'none';
  readonly random?: () => number;
}): (context: RetryDelayContext) => number {
  assertDuration(options.baseMs, 'baseMs');
  assertDuration(options.capMs, 'capMs');

  if (options.jitter !== 'full' && options.jitter !== 'none') throw new Error('Invalid jitter');

  const random = options.random ?? Math.random;

  return ({ retryNumber }) => {
    const exponential = Math.min(options.capMs, options.baseMs * 2 ** (retryNumber - 1));

    return options.jitter === 'full' ? random() * exponential : exponential;
  };
}
