# Validator client shutdown hang repro (Charon-style, no cluster)

Reproduces Lodestar VC hanging on SIGINT/SIGTERM when talking to a DV middleware
that holds SSE open and stalls `beacon_committee_selections`, without needing a
full Charon cluster. Targets PR [#10441](https://github.com/ChainSafe/lodestar/pull/10441).

## Prerequisites

- Node `^24.13` (see repo `engines`)
- From repo root on this branch (or any checkout with the harness):

```bash
corepack enable
pnpm install
pnpm build
```

## Quick repro (unpatched `unstable`)

```bash
# From repo root, at merge-base / unstable without the PR fixes:
node scripts/repro-vc-shutdown/run-repro.mjs \
  --label unstable-SIGINT \
  --signal SIGINT \
  --boundMs 10000 \
  --requestTimeoutMs 60000
```

Expected on unpatched code: process still alive after 10s (`FAIL_HUNG` or
`FAIL_EXIT_SLOW`), exit code `2`. Logs and handle dumps land under
`/opt/cursor/artifacts/lodestar-vc-shutdown/logs/<label>/` (or `--outDir`).

```bash
# Same with SIGTERM
node scripts/repro-vc-shutdown/run-repro.mjs \
  --label unstable-SIGTERM \
  --signal SIGTERM \
  --boundMs 10000 \
  --requestTimeoutMs 60000
```

## What the stub does

`stub-bn.mjs` is a plain Node HTTP server that:

| Endpoint | Behavior |
|---|---|
| `GET /eth/v1/beacon/genesis` | genesisTime ≈ now |
| `GET /eth/v1/config/spec` | `{}` (skips critical-param assert) |
| `GET /eth/v1/node/syncing` | not syncing |
| `GET /eth/v1/events` | SSE held open + keepalives |
| `POST .../validators` | interop pubkeys 0..3 as active |
| `POST .../duties/attester/{epoch}` | synthetic duties |
| `POST .../beacon_committee_selections` | **stall forever** (Charon-style) |
| `POST .../sync_committee_selections` | stall forever |
| other `/eth/*` | empty 200 |

## VC flags used

```text
validator --network=dev --distributed --interopIndexes=0..3 \
  --server=http://127.0.0.1:19596 --http.requestTimeout=60000
```

Raised `--http.requestTimeout` mirrors Charon deployments. `--distributed`
enables the committee-selection exchange that Charon implements.

## Patched PR branch

Checkout the PR commit (do **not** push to the PR branch from this harness work),
rebuild, re-run the same `run-repro.mjs` command. Expected: exit within 10s
(`PASS_EXIT_WITHIN_BOUND`, exit code `0`).

## Variant matrix (minimal-fix analysis)

Apply each of the three PR hunks alone (and combinations) on top of unstable,
rebuild `api` / `validator` / `cli` as needed, then:

```bash
node scripts/repro-vc-shutdown/run-matrix.mjs
```

See `REPORT.md` under `/opt/cursor/artifacts/lodestar-vc-shutdown/` for measured
exit times and which changes are necessary vs hardening.

## Handle evidence

The VC is launched with `--import scripts/repro-vc-shutdown/dump-handles.mjs`,
which dumps `process._getActiveHandles()` / `_getActiveRequests()` after the
shutdown signal. On hang, `run-repro.mjs` also writes `/proc/<pid>/fd` links.
