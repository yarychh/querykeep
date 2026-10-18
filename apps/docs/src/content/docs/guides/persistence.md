---
title: Persistence
description: Restore a snapshot before create, then follow snapshots$ yourself.
---

The library does not ship a store. Restore first, then create the query. `dispose()` completes `snapshots$` after the current source notification. It does not flush external storage, and it does not delete consumer-owned data.

Ordering writes is optional RxJS. An `async` function passed to `subscribe` does not order writes: the next notification can arrive before that function's promise settles. Write errors, and writes still running after dispose, belong to that consumer stream.

```ts
import { concatMap } from 'rxjs';

const restored = await readSnapshot(key);
const query = client.query({
  key,
  initialSnapshot: restored,
  queryFn: ({ signal }) => load(signal),
});

query.snapshots$.pipe(concatMap((snapshot) => writeSnapshot(key, snapshot))).subscribe({
  error: reportWriteFailure,
});
```

`initialSnapshot` is replayed on `snapshots$` with its original `receivedAt`. The next accepted success replaces both the data and the timestamp, even when the payload is equal.

`state()`, `state$`, and `snapshots$` copy the envelope and `{ data, receivedAt }`. They do not clone `data`. A `Date`, a `Map`, or any other payload value is the same reference the source returned. Treat it as read-only.

There is no combined-query type. Combine views in your code:

```ts
import { combineLatest } from 'rxjs';

combineLatest([
  prices.select((state) => state.snapshot?.data),
  fx.select((state) => state.snapshot?.data),
]).subscribe(renderPair);
```
