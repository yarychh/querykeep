import { createQueryClient } from '../src/index.js';
import type { QueryState } from '../src/index.js';

const REFRESH_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 45_000;
const REQUEST_RETRIES = 2;
const RETRY_DELAY_MS = 10_000;
const STALE_THRESHOLD_MS = 180_000;
const FETCH_DURATION_MINUTES = 60;
const MAX_DEPARTURES_PER_STOP = 8;
const UPSTREAM_RESULT_LIMIT = MAX_DEPARTURES_PER_STOP * 3;

const API_BASES = [
  { via: 'vbb', url: 'https://v6.vbb.transport.rest' },
  { via: 'bvg', url: 'https://v6.bvg.transport.rest' },
] as const;

type ApiBase = (typeof API_BASES)[number];

const STOPS = [
  { id: '900055101', label: 'U Viktoria-Luise-Platz' },
  { id: '900042101', label: 'U Spichernstr.' },
  { id: '900055108', label: 'Bamberger Str.' },
] as const;

type Stop = (typeof STOPS)[number];

type Departure = {
  line: string;
  direction: string;
  minutes: number;
  delaySeconds: number | null;
  cancelled: boolean;
};

type StopBoard = {
  via: ApiBase['via'];
  departures: Departure[];
};

type RawDeparture = {
  direction?: string;
  line?: { name?: string };
  when?: string | null;
  plannedWhen?: string;
  delay?: number | null;
  cancelled?: boolean;
};

class UpstreamStatusError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function shouldRetry(error: unknown): boolean {
  if (error instanceof UpstreamStatusError) return error.status === 429 || error.status >= 500;

  if (error instanceof Error && error.name === 'AbortError') return false;

  return true;
}

function retryAfterMs(header: string | null): number {
  const seconds = header === null ? Number.NaN : Number(header);

  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : RETRY_DELAY_MS;
}

const client = createQueryClient({
  defaults: {
    intervalMs: REFRESH_INTERVAL_MS,
    timeoutMs: REQUEST_TIMEOUT_MS,
    retry: {
      maxAttempts: REQUEST_RETRIES + 1,
      delayMs: RETRY_DELAY_MS,
      shouldRetry,
    },
  },
  concurrency: STOPS.length,
  maxQueued: 8,
  providers: {
    transport: { concurrency: 2, minIntervalMs: 1_000 },
  },
});

async function requestDepartures(
  base: ApiBase,
  stop: Stop,
  signal: AbortSignal,
): Promise<StopBoard> {
  const url = new URL(`/stops/${stop.id}/departures`, base.url);

  url.searchParams.set('duration', String(FETCH_DURATION_MINUTES));
  url.searchParams.set('results', String(UPSTREAM_RESULT_LIMIT));
  url.searchParams.set('pretty', 'false');

  const response = await fetch(url, {
    signal,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'querykeep-example/0.1',
    },
  });

  if (response.status === 429) {
    client.cooldown('transport', retryAfterMs(response.headers.get('retry-after')));
    throw new UpstreamStatusError(`upstream 429 for ${stop.label}`, response.status);
  }

  if (!response.ok)
    throw new UpstreamStatusError(`upstream ${response.status} for ${stop.label}`, response.status);

  const body = (await response.json()) as { departures?: RawDeparture[] };
  const now = Date.now();
  const departures = (body.departures ?? [])
    .flatMap((raw) => {
      const departure = normalizeDeparture(raw, now);

      return departure ? [departure] : [];
    })
    .toSorted((a, b) => a.minutes - b.minutes)
    .slice(0, MAX_DEPARTURES_PER_STOP);

  return { via: base.via, departures };
}

function normalizeDeparture(raw: RawDeparture, now: number): Departure | undefined {
  const cancelled = raw.cancelled === true;
  const effective = (cancelled ? null : raw.when) ?? raw.plannedWhen ?? raw.when;

  if (!effective) return undefined;

  const at = new Date(effective).getTime();

  if (!Number.isFinite(at)) return undefined;

  const minutes = Math.round((at - now) / 60_000);

  if (minutes < 0) return undefined;

  return {
    line: raw.line?.name ?? '?',
    direction: raw.direction ?? '—',
    minutes,
    delaySeconds: raw.delay ?? null,
    cancelled,
  };
}

/** One attempt walks the bases. Refresh, timeout, and retry stay on the query. */
async function loadDepartures(stop: Stop, signal: AbortSignal): Promise<StopBoard> {
  let lastError: unknown;

  for (const base of API_BASES) {
    signal.throwIfAborted();

    try {
      return await requestDepartures(base, stop, signal);
    } catch (error) {
      if (signal.aborted || (error instanceof UpstreamStatusError && error.status === 429))
        throw error;

      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`upstream failed for ${stop.label}`);
}

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delayLabel(delaySeconds: number | null): string {
  if (delaySeconds === null || delaySeconds === 0) return '';

  const minutes = Math.round(delaySeconds / 60);

  if (minutes === 0) return '';

  return minutes > 0 ? ` +${minutes}m` : ` ${minutes}m`;
}

function formatDeparture(departure: Departure): string {
  const flags = `${delayLabel(departure.delaySeconds)}${departure.cancelled ? ' cancelled' : ''}`;

  return `  ${departure.line.padEnd(6)} ${departure.direction.padEnd(28)} ${String(departure.minutes).padStart(2)} min${flags}`;
}

function formatStop(stop: Stop, state: QueryState<StopBoard>): string {
  const receivedAt = state.snapshot?.receivedAt;
  const board = state.snapshot?.data;
  const status = [
    state.phase,
    state.paused ? 'paused' : undefined,
    state.error ? `error: ${errorText(state.error)}` : undefined,
    board === undefined ? 'no data' : `via ${board.via}`,
    receivedAt === undefined ? undefined : `received ${clockTime(receivedAt)}`,
    receivedAt !== undefined && Date.now() - receivedAt > STALE_THRESHOLD_MS ? 'stale' : undefined,
  ]
    .filter((part) => part !== undefined)
    .join('  ');
  const departures = board?.departures ?? [];
  const rows =
    board === undefined
      ? []
      : departures.length === 0
        ? ['  (none)']
        : departures.map(formatDeparture);

  return [`${stop.label}  ${status}`, ...rows].join('\n');
}

const queries = STOPS.map((stop) => ({
  stop,
  query: client.query({
    key: ['departures', stop.id],
    provider: 'transport',
    queryFn: ({ signal }) => loadDepartures(stop, signal),
  }),
}));

const seen = new Map<string, string>();

function renderStop(stop: Stop, state: QueryState<StopBoard>): void {
  const text = formatStop(stop, state);

  if (seen.get(stop.id) === text) return;

  seen.set(stop.id, text);
  console.log(`\n${clockTime(Date.now())}\n${text}`);
}

console.log(
  `watching ${STOPS.length} stops, refresh ${REFRESH_INTERVAL_MS / 1000}s, timeout ${REQUEST_TIMEOUT_MS / 1000}s, retries ${REQUEST_RETRIES}. Ctrl+C to stop.`,
);

for (const { stop, query } of queries) query.state$.subscribe((state) => renderStop(stop, state));

let closing = false;

function shutdown(signal: string): void {
  if (closing) return;

  closing = true;
  console.log(`\n${signal}, disposing`);
  client.dispose();
  console.log(
    'shutdown disposed queries; in-flight source promises release their slots when they settle',
  );
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

await new Promise(() => {});
