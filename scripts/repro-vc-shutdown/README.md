# Validator client shutdown hang repro (Charon-style, no cluster)

Reproduces a Lodestar validator client hanging on SIGINT/SIGTERM when connected
to DV middleware that holds the beacon event stream open and stalls
`beacon_committee_selections`, without needing a full Charon cluster.

Related upstream PR: [ChainSafe/lodestar#10441](https://github.com/ChainSafe/lodestar/pull/10441).

## Prerequisites

- Node matching the repo `engines` field
- From the repository root:

```bash
corepack enable
pnpm install
pnpm build
```

## Quick repro (unpatched `unstable`)

This branch (`repro/vc-shutdown-hang`) is based on the PR merge-base (`unstable`
at `708700cdf`) **without** the three PR fixes applied:

```bash
node scripts/repro-vc-shutdown/run-repro.mjs \
  --label unstable-SIGINT \
  --signal SIGINT \
  --boundMs 10000 \
  --requestTimeoutMs 60000 \
  --hangWaitMs 90000
```

Expected: process still alive well past 10s (`FAIL_HUNG` / `FAIL_EXIT_SLOW`).
Natural exit is ~65s (the raised HTTP request timeout). Same with
`--signal SIGTERM`.

Logs default to `./repro-logs/<label>/` (gitignored). Override with `--outDir`.

## Patched PR tip

Checkout the PR commit, rebuild, and re-run the same command (copy this harness
directory onto that checkout if needed):

```bash
git fetch origin b0a7/vc-shutdown-hardening   # or the upstream PR head
git checkout 8cec890993d11fd3c19ac0599dedac9e2e404c95
pnpm install && pnpm build

node scripts/repro-vc-shutdown/run-repro.mjs \
  --label pr10441-SIGINT \
  --signal SIGINT \
  --boundMs 10000 \
  --requestTimeoutMs 60000
```

Expected: exit within 10s (`PASS_EXIT_WITHIN_BOUND`, typically ~2–6s).

## What the stub does

`stub-bn.mjs` is a plain Node HTTP server (no Lodestar imports):

| Endpoint | Behavior |
|---|---|
| `GET /eth/v1/beacon/genesis` | `genesisTime` ≈ now |
| `GET /eth/v1/config/spec` | `{}` (skips critical-param assert) |
| `GET /eth/v1/node/syncing` | not syncing |
| `GET /eth/v1/events` | SSE held open + keepalives |
| `POST .../validators` | interop pubkeys 0..3 as active |
| `POST .../duties/attester/{epoch}` | synthetic duties |
| `POST .../beacon_committee_selections` | **stall forever** |
| `POST .../sync_committee_selections` | stall forever |
| other `/eth/*` | empty 200 |

## VC flags used

```text
validator --network=dev --distributed --interopIndexes=0..3 \
  --server=http://127.0.0.1:19596 --http.requestTimeout=60000
```

Raised `--http.requestTimeout` mirrors Charon deployments. `--distributed`
enables the committee-selection exchange that Charon implements. `--network=dev`
uses the minimal preset (6s slots).

## Hang mechanism

On unpatched shutdown:

1. Graceful shutdown aborts the VC `AbortController`. The in-flight epoch-0
   selections request aborts; the EventSource closes.
2. A concurrent duty path still starts epoch-1
   `submitBeaconCommitteeSelections` **after** the parent signal is already
   aborted.
3. `HttpClient._request` only registers `abort` listeners and does not check
   `signal.aborted`, so it waits the full `timeoutMs` (60s here).
4. The open TCP socket to the stub remains in Node’s active handles and keeps
   the process alive until that timeout fires (~65s measured).

Handle dumps (via `--import dump-handles.mjs`) show a live socket to the stub
port while the process is hung. On hang past `--hangWaitMs`, `run-repro.mjs`
also samples `/proc/<pid>/fd`.

## Results

Conditions: exit bound **10s**, `--http.requestTimeout=60000`, `--network=dev`
(6s slots), 3 runs per cell. Baseline matrix rows used a 20s wait-then-kill;
a separate unpatched run waited out the natural ~65s exit.

| Variant | SIGINT avg exit (ms) | SIGTERM avg exit (ms) | Within 10s? |
|---|---|---|---|
| none (unpatched) | ~20009 (still alive at 20s kill) | ~20009 | NO |
| none natural timeout | 65357 (1 run) | — | NO |
| A `process.exit` after cleanup | 2293 | 2208 | YES |
| B HttpClient abort if already aborted | 1902 | 2272 | YES |
| C selections `timeoutMs` ≤ one slot | 8304 | 8319 | YES\* |
| A+B | 2082 | 2421 | YES |
| A+C | 2058 | 1972 | YES |
| B+C | 2001 | 2924 | YES |
| A+B+C (full PR) | 2158 | 2479 | YES |
| PR tip `8cec89099` | ~2949 | ~4070 | YES |

\*C alone passes the 10s bound only because `dev` slots are 6s. On mainnet
(12s slots) C alone would be ~12s+ and fail a 10s bound; it does not remove the
post-abort request race.

### Conclusion

| Change | Role |
|---|---|
| **B** HttpClient already-aborted check | Root-cause shutdown fix |
| **A** `process.exit` after VC cleanup | Sufficient alone; defense-in-depth (beacon-node parity) |
| **C** selections wait capped to one slot | Charon ops hardening; not required for this hang once A or B is present |

Recommended shutdown fix: **A+B**. Keep **C** as related duty-path hardening when
`--http.requestTimeout` is raised for DV middleware.

## Variant matrix

The three PR hunks are extracted under `patches/`:

| Letter | Change |
|---|---|
| A | `process.exit` after VC cleanup (`packages/cli/.../handler.ts`) |
| B | HttpClient abort if signal already aborted (`packages/api/.../httpClient.ts`) |
| C | Cap `submitBeaconCommitteeSelections` wait to one slot (`packages/validator/.../attestationDuties.ts`) |

```bash
# Apply letters onto this branch’s tree, rebuild, run trials
node scripts/repro-vc-shutdown/apply-variant.mjs A B    # or none|A|B|C|...
pnpm --filter @lodestar/api --filter @lodestar/validator --filter @chainsafe/lodestar build
node scripts/repro-vc-shutdown/run-matrix.mjs --label A+B --runs 3

# Or orchestrate all combinations
node scripts/repro-vc-shutdown/run-all-variants.mjs --runs 3
```

Pre-applied single-change and full-fix branches on `b0a7/lodestar` (same harness
base):

| Branch | Contents |
|---|---|
| `repro/vc-shutdown-variant-1` | A only |
| `repro/vc-shutdown-variant-2` | B only |
| `repro/vc-shutdown-variant-3` | C only |
| `repro/vc-shutdown-variant-abc` | A+B+C |

## Unit tests (PR-touched)

With A+B+C applied (or on the PR tip):

```bash
pnpm vitest run --project unit packages/api/test/unit/client/httpClient.test.ts
pnpm vitest run --project unit packages/validator/test/unit/services/attestationDuties.test.ts
```
