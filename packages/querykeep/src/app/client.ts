import { asyncScheduler } from 'rxjs';
import type { Observable, SchedulerLike } from 'rxjs';

import type { ProviderLimits } from '../domain/admission.js';
import { assertQueryFn } from '../domain/attempt.js';
import type { QueryFn } from '../domain/attempt.js';
import { assertDuration, assertPositiveInteger } from '../domain/duration.js';
import { keyId } from '../domain/identity.js';
import type { QueryKey } from '../domain/identity.js';
import { resolvePolicy } from '../domain/policy.js';
import type { ResolvedPolicy } from '../domain/policy.js';
import type { RetryConfig } from '../domain/retry.js';
import { assertSnapshot } from '../domain/state.js';
import type { Snapshot } from '../domain/state.js';
import { createAdmission } from '../runtime/admission.js';
import { createManagedQuery } from './query.js';
import type { Query } from './query.js';

export interface ClientConfig {
  readonly defaults?: {
    readonly intervalMs?: number | false;
    readonly timeoutMs?: number;
    readonly admissionTimeoutMs?: number;
    readonly retry?: RetryConfig;
  };
  readonly concurrency?: number;
  readonly maxQueued?: number;
  readonly providers?: Readonly<Record<string, ProviderLimits>>;
  readonly now?: () => number;
  readonly elapsed?: () => number;
  readonly scheduler?: SchedulerLike;
}

export interface ClientQueryConfig<T> {
  readonly key: QueryKey;
  readonly queryFn: QueryFn<T>;
  readonly provider?: string;
  readonly intervalMs?: number | false;
  readonly timeoutMs?: number;
  readonly admissionTimeoutMs?: number;
  readonly retry?: RetryConfig;
  readonly initialSnapshot?: Snapshot<T>;
  readonly enabled?: boolean;
  readonly refreshOn$?: Observable<unknown>;
  readonly enabled$?: Observable<boolean>;
}

export interface QueryClient {
  query<T>(config: ClientQueryConfig<T>): Query<T>;
  get<T = unknown>(key: QueryKey): Query<T> | undefined;
  cooldown(provider: string, delayMs: number): void;
  dispose(): void;
}

function assertObservable(value: unknown, name: string): void {
  if (
    value == null ||
    typeof value !== 'object' ||
    typeof (value as { subscribe?: unknown }).subscribe !== 'function'
  ) {
    throw new Error(`Invalid ${name}`);
  }
}

function assertQueueLimit(value: number, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${name}`);
  }

  return value;
}

export function createQueryClient(config: ClientConfig = {}): QueryClient {
  const scheduler = config.scheduler ?? asyncScheduler;
  const elapsed = config.elapsed ?? (() => performance.now());
  const now = config.now ?? (() => Date.now());
  const defaults: ResolvedPolicy = resolvePolicy(config.defaults ?? {});
  const providers = new Map<string, ProviderLimits>();

  for (const [name, limits] of Object.entries(config.providers ?? {})) {
    providers.set(name, {
      concurrency:
        limits.concurrency === undefined
          ? undefined
          : assertPositiveInteger(limits.concurrency, 'provider.concurrency'),
      minIntervalMs:
        limits.minIntervalMs === undefined
          ? 0
          : assertDuration(limits.minIntervalMs, 'provider.minIntervalMs'),
    });
  }

  const admission = createAdmission({
    concurrency: assertPositiveInteger(config.concurrency ?? 4, 'concurrency'),
    maxQueued: assertQueueLimit(config.maxQueued ?? 256, 'maxQueued'),
    providers,
    elapsed,
    scheduler,
  });
  const queries = new Map<string, Query<unknown> | null>();
  let disposed = false;

  const client: QueryClient = {
    query<T>(input: ClientQueryConfig<T>): Query<T> {
      if (disposed) throw new Error('Client disposed');

      assertQueryFn(input.queryFn);

      if (input.refreshOn$) assertObservable(input.refreshOn$, 'refreshOn$');

      if (input.enabled$) assertObservable(input.enabled$, 'enabled$');

      const id = keyId(input.key);

      if (queries.has(id)) throw new Error(`Duplicate query key: ${id}`);

      if (input.provider !== undefined && !providers.has(input.provider)) {
        throw new Error(`Unknown provider: ${input.provider}`);
      }

      queries.set(id, null);

      try {
        const policy = resolvePolicy(input, defaults);
        const query = createManagedQuery<T>({
          queryFn: input.queryFn,
          intervalMs: policy.intervalMs,
          timeoutMs: policy.timeoutMs,
          admissionTimeoutMs: policy.admissionTimeoutMs,
          retry: policy.retry,
          initialSnapshot: assertSnapshot(input.initialSnapshot),
          enabled: input.enabled !== false,
          refreshOn$: input.refreshOn$,
          enabled$: input.enabled$,
          now,
          scheduler,
          admission,
          key: id,
          provider: input.provider,
          onDispose: () => queries.delete(id),
        });

        if (!query.state().disposed) queries.set(id, query);

        return query;
      } catch (error) {
        queries.delete(id);
        throw error;
      }
    },
    get<T = unknown>(key: QueryKey): Query<T> | undefined {
      const live = queries.get(keyId(key));

      if (!live) return undefined;

      return live as Query<T>;
    },
    cooldown(provider, delayMs) {
      if (disposed) throw new Error('Client disposed');

      if (!providers.has(provider)) throw new Error(`Unknown provider: ${provider}`);

      admission.cooldown(provider, assertDuration(delayMs, 'delayMs'));
    },
    dispose() {
      if (disposed) return;

      disposed = true;
      const live = Array.from(queries.values());

      // Close first so a queued wait records AdmissionClosedError before dispose completes the streams.
      admission.close();

      for (const query of live) query?.dispose();
    },
  };

  return client;
}
