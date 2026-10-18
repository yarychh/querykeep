---
title: Why Querykeep
description: When a shared admission layer is the thing you would otherwise hand-roll.
---

Applications that poll an external API often grow a timer, a variable for the last value, and a boolean for "request in flight". That works for one call. It gets expensive when several stops, feeds, or devices share one upstream budget: overlapping requests, retry storms, a dropped snapshot on the first error, and a poll loop that dies when the last view unmounts.

Querykeep is the piece that owns that loop for one process.

- One canonical key has one in-flight call. Readers share the snapshot.
- The client caps concurrency, spaces starts, and records a provider cooldown. A ticket blocked on one provider does not block another.
- The last accepted success stays in place through retries and admission failures. `receivedAt` tells you how old it is.
- The query keeps running with zero subscribers. `pause`, `resume`, and `dispose` are explicit.

You still write `queryFn`. The library does not know HTTP, GraphQL, or your schema. You parse `Retry-After` and pass the delay to `client.cooldown`.

## What to use instead

| Need                                                                                                                | Fit                      |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| One process polls a rate-limited source, several readers share the result, and the loop should outlive any one view | Querykeep                |
| A component cache with stale time, focus or reconnect revalidation, mutations, and React or Vue bindings            | TanStack Query           |
| An RxJS poll that should stop when the subscriber unsubscribes, and should error the stream when retries run out    | `rx-polling`             |
| A queue of tasks, with no snapshot, no key, and no retained last success                                            | `p-queue` plus `p-retry` |
| A single `setInterval` around one call                                                                              | A timer is enough        |

Querykeep assumes an RxJS peer dependency. The quickstart does not use operators. `refreshOn$`, `enabled$`, and `select` are the places RxJS shows up in your code. If you do not want that dependency, TanStack Query core is the more usual choice, and it does not share a provider admission budget across queries.

## What this alpha will not grow into

Limits stay inside one client. There is no cross-tab leader, no durable job runner, and no storage port. Freshness is a comparison you make against `receivedAt`. A busy cycle drops extra triggers instead of queueing a trailing run. Those are deliberate. The [limits](/guides/limits/) page lists them.
