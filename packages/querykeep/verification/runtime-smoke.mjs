import { createQuery, keyId } from 'querykeep';

const id = keyId(['smoke']);

if (id !== '["smoke"]') {
  throw new Error(`unexpected keyId ${id}`);
}

const query = createQuery({
  intervalMs: false,
  queryFn: async () => 'ok',
});

const state = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    subscription.unsubscribe();
    reject(new Error('runtime smoke timed out'));
  }, 2000);
  const subscription = query.state$.subscribe((next) => {
    if (next.snapshot?.data === 'ok') {
      clearTimeout(timer);
      subscription.unsubscribe();
      resolve(next);
    }
  });
});

if (state.phase !== 'idle' || state.snapshot?.data !== 'ok') {
  throw new Error(`unexpected smoke state ${JSON.stringify(state)}`);
}

query.dispose();
const done = query.state();

if (done.disposed !== true || done.snapshot?.data !== 'ok') {
  throw new Error(`unexpected disposed state ${JSON.stringify(done)}`);
}

console.log('runtime smoke ok');
