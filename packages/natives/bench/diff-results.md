# Native diff benchmark

- Source: `1b3e35716e64c16c019564a52c58019b54d9733d` (clean tree), ci-profile native build, `PI_COMPILED=1`
- Runtime: bun 1.3.14, darwin-arm64 (Apple M4 Pro)
- Method: seeded synthetic docs, per-scenario warmup + timed iterations, serial runs (no concurrent load), crossing-inclusive (measures the full N-API boundary)
- Command: `PI_COMPILED=1 bun packages/natives/bench/diff.ts` (`BENCH_WARMUP` / `BENCH_ITERATIONS` / `BENCH_MAX_LINES` env overrides)

## High-precision run (warmup 20, iterations 300/scenario, scenarios ≤ 5000 lines)

| scenario | jsdiff diffLines | native diffLines | speedup | jsdiff structuredPatch | native hunks | speedup |
|---|---|---|---|---|---|---|
| 100 lines / 1% edits | 22.3µs | 11.0µs | 2.0x | 33.0µs | 10.4µs | 3.2x |
| 100 lines / 20% edits | 50.0µs | 26.9µs | 1.9x | 62.7µs | 26.1µs | 2.4x |
| 5000 lines / 1% edits | 906.4µs | 562.6µs | 1.6x | 1.33ms | 629.6µs | 2.1x |
| 5000 lines / 20% edits | 165.79ms | 24.51ms | 6.8x | 154.89ms | 22.95ms | 6.7x |

## Full run including 50k-line scenarios (warmup 2, iterations 10/scenario)

Reduced iterations because jsdiff needs ~26s per iteration on the heaviest row.

| scenario | jsdiff diffLines | native diffLines | speedup | jsdiff structuredPatch | native hunks | speedup |
|---|---|---|---|---|---|---|
| 100 lines / 1% edits | 61.7µs | 12.7µs | 4.9x | 61.6µs | 11.4µs | 5.4x |
| 100 lines / 20% edits | 58.8µs | 29.6µs | 2.0x | 91.7µs | 27.6µs | 3.3x |
| 5000 lines / 1% edits | 1.33ms | 602.5µs | 2.2x | 2.11ms | 561.4µs | 3.8x |
| 5000 lines / 20% edits | 182.69ms | 26.80ms | 6.8x | 156.84ms | 24.02ms | 6.5x |
| 50000 lines / 1% edits | 48.30ms | 13.97ms | 3.5x | 50.45ms | 10.59ms | 4.8x |
| 50000 lines / 20% edits | 25749.69ms | 2402.27ms | 10.7x | 29119.74ms | 2882.79ms | 10.1x |

## Notes

- Native wins at every measured size; no crossover where the N-API crossing cost dominates (100-line inputs are still ~2-3x).
- The worst jsdiff case (50k lines / 20% edit density) is a ~26s synchronous stall on the render path vs ~2.4s native.
- Behavior parity with jsdiff is defended by `packages/natives/test/diff-parity.test.ts` (fixed edge cases, seeded random documents including CRLF/unicode/no-trailing-newline, seeded random word diffs, and a 10k-line document) plus the existing `packages/coding-agent/test/tools/edit-diff.test.ts`, all run with `PI_COMPILED=1 bun test`.
