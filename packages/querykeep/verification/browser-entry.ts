import { createQuery } from 'querykeep';

const query = createQuery({
  intervalMs: false,
  queryFn: async () => 'browser-ok',
});

query.state$.subscribe((state) => {
  if (state.snapshot?.data === 'browser-ok') {
    document.body.textContent = 'browser smoke ok';
    query.dispose();
  }
});
