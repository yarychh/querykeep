# Querykeep

Shared, in-memory snapshots of asynchronous sources, with admission and retries.

Querykeep polls an asynchronous source on a schedule you set and keeps the last accepted result, the error, and the phase in one place. One client shares concurrency, start spacing, and provider cooldown across queries, so several readers in one process can observe one rate-limited source without each running its own timer.

The library lives in [`packages/querykeep`](packages/querykeep/README.md). That README is the behavioral contract consumers read, and the docs app follows it.

```
querykeep/
├── apps/docs/          # Starlight documentation site.
├── packages/querykeep/ # The publishable library package.
```

## Scripts

From the repository root:

```bash
bun install
bun run --filter querykeep test
bun run --filter querykeep typecheck
bun run --filter querykeep build
bun run --filter querykeep demo
```

`bun run --filter querykeep demo` polls a few VBB stops and prints departures until Ctrl+C.

From `packages/querykeep`, the same checks are `bun run typecheck`, `bun run build`, `bun test ./test`, and `bun run demo`. `tsc` compiles `src/` to `dist/`. Node 22+ is the declared consumer runtime. The public build uses DOM and ES2023 types only, so a browser project does not need `@types/node`.

Querykeep is available under the [MIT License](LICENSE).
