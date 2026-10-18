# querykeep

Workspace for the Querykeep library and its documentation site.

```
querykeep/
├── apps/docs/          # Starlight site. Unpublished.
├── packages/querykeep/ # The library. Private until a license is chosen and a release is authorized.
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

The package README is the behavioral contract consumers will read. The docs app should follow that README. No license is chosen yet, and `querykeep` stays `private` until publication is authorized.
