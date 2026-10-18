---
title: Recipes
description: Retry-After, page visibility, a React subscription, and an Angular template.
---

These snippets sit outside the library. Copy the parts you need. They do not add a framework package.

## Retry-After

`Retry-After` is either a number of seconds or an HTTP date. `cooldown` only extends the provider's not-before time, so a shorter later value does not undo a longer one.

```ts
function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (header === null || header.trim() === '') return undefined;

  const seconds = Number(header);

  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const at = Date.parse(header);

  if (Number.isNaN(at)) return undefined;

  return Math.max(0, at - now);
}

async function load(signal: AbortSignal): Promise<Board> {
  const response = await fetch(url, { signal });

  if (response.status === 429) {
    client.cooldown('transport', retryAfterMs(response.headers.get('retry-after')) ?? 1_000);
    throw new Error('rate limited');
  }

  if (!response.ok) throw new Error(`upstream ${response.status}`);

  return (await response.json()) as Board;
}
```

## Pause while the tab is hidden

`enabled$` is the external gate. A synchronous `false` blocks the first cycle. A later `true` does not clear a manual `pause()`.

```ts
import { fromEvent, map, startWith } from 'rxjs';

const visible$ = fromEvent(document, 'visibilitychange').pipe(
  startWith(undefined),
  map(() => document.visibilityState === 'visible'),
);

const board = client.query({
  key: ['board'],
  enabled$: visible$,
  queryFn: ({ signal }) => load(signal),
});
```

Hiding the tab sets `blocked`, aborts the active attempt, and keeps the snapshot. Showing it starts one cycle. Browser timers can still be throttled while the tab is in the background; this gate is how you stop scheduling on purpose.

## Share one query across modules

`get` returns the live query or `undefined`. The type argument is not checked. `query()` throws if that key is already registered, so call `get` first. Two callers that both pass `get` and both reach `query()` on the same stack still hit the duplicate error, because the registry entry exists before `query()` returns.

```ts
import type { Query } from 'querykeep';

function departures(stopId: string): Query<Departure[]> {
  const key = ['departures', stopId] as const;

  return (
    client.get<Departure[]>(key) ??
    client.query({
      key,
      provider: 'transport',
      queryFn: ({ signal }) => fetchDepartures(stopId, signal),
    })
  );
}
```

`departures(stopId).key` is the canonical string, the same value `keyId(key)` returns.

## React

The hook subscribes to a query the client already owns. Unsubscribing on unmount does not pause or dispose that query.

```tsx
import { useEffect, useState } from 'react';
import type { Query, QueryState } from 'querykeep';

function useQueryState<T>(query: Query<T>): QueryState<T> {
  const [state, setState] = useState(() => query.state());

  useEffect(() => {
    const subscription = query.state$.subscribe(setState);

    return () => subscription.unsubscribe();
  }, [query]);

  return state;
}
```

Call `query.pause()` or `client.dispose()` from the place that owns the lifetime. The component that only renders `state.snapshot` is a reader.

## Angular

The async pipe subscribes in the template and unsubscribes when the view goes away. The query keeps polling. `departures` is the helper from the previous section.

```ts
import { AsyncPipe } from '@angular/common';
import { Component } from '@angular/core';

@Component({
  imports: [AsyncPipe],
  template: `
    @if (query.state$ | async; as state) {
      <p>{{ state.phase }}</p>
    }
  `,
})
export class BoardComponent {
  readonly query = departures('stop-A');
}
```
