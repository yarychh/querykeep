import { assertDuration, assertPositiveInteger } from './duration.js';
import { resolveRetry } from './retry.js';
import type { ResolvedRetry, RetryConfig } from './retry.js';

export interface ResolvedPolicy {
  readonly intervalMs: number | false;
  readonly timeoutMs: number;
  readonly admissionTimeoutMs: number;
  readonly retry: ResolvedRetry;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_ADMISSION_TIMEOUT_MS = 30_000;

export function resolveInterval(
  value: number | false | undefined,
  fallback: number | false,
): number | false {
  const interval = value === undefined ? fallback : value;

  if (interval === false) return false;

  return assertPositiveInteger(interval, 'intervalMs');
}

export function resolvePolicy(
  input: {
    readonly intervalMs?: number | false;
    readonly timeoutMs?: number;
    readonly admissionTimeoutMs?: number;
    readonly retry?: RetryConfig;
  },
  defaults?: ResolvedPolicy,
): ResolvedPolicy {
  const base: ResolvedPolicy = defaults ?? {
    intervalMs: DEFAULT_INTERVAL_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    admissionTimeoutMs: DEFAULT_ADMISSION_TIMEOUT_MS,
    retry: resolveRetry(undefined),
  };

  return {
    intervalMs: resolveInterval(input.intervalMs, base.intervalMs),
    timeoutMs:
      input.timeoutMs === undefined ? base.timeoutMs : assertDuration(input.timeoutMs, 'timeoutMs'),
    admissionTimeoutMs:
      input.admissionTimeoutMs === undefined
        ? base.admissionTimeoutMs
        : assertDuration(input.admissionTimeoutMs, 'admissionTimeoutMs'),
    retry: resolveRetry(input.retry, base.retry),
  };
}
