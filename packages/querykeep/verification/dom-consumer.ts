import {
  AdmissionClosedError,
  AdmissionOverflowError,
  AdmissionTimeoutError,
  AttemptTimeoutError,
  createQuery,
  createQueryClient,
  exponentialBackoff,
  keyId,
  type QueryConfig,
  type QueryState,
  type Snapshot,
} from 'querykeep';

const delay = exponentialBackoff({ baseMs: 100, capMs: 1_000, jitter: 'none' });
const id = keyId(['dom', { ok: true }]);

const config: QueryConfig<string> = {
  intervalMs: false,
  queryFn: ({ signal }) => {
    signal.throwIfAborted();

    return Promise.resolve(`dom:${delay({ retryNumber: 1 })}`);
  },
};

const client = createQueryClient({
  providers: { transport: { concurrency: 1, minIntervalMs: 0 } },
});

const query = client.query<{ n: number }>({
  key: ['dom', id],
  provider: 'transport',
  queryFn: ({ signal }) => {
    signal.throwIfAborted();

    return Promise.resolve({ n: 1 });
  },
});

const standalone = createQuery(config);
const state: QueryState<{ n: number }> = query.state();
const restored: Snapshot<string> | undefined = standalone.state().snapshot;

query.state$.subscribe((next) => {
  void next.phase;
});
standalone.snapshots$.subscribe((snapshot) => {
  void snapshot.receivedAt;
});

void state.snapshot;
void restored;
void AdmissionOverflowError;
void AdmissionTimeoutError;
void AdmissionClosedError;
void AttemptTimeoutError;

query.dispose();
standalone.dispose();
client.dispose();
