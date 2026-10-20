#!/usr/bin/env node
/**
 * Minimal Charon-like Beacon API stub for VC shutdown hang repro.
 *
 * Serves enough Beacon API for a Lodestar VC (--network=dev, interop keys,
 * --distributed) to start, holds /eth/v1/events open, and stalls selected
 * DV middleware endpoints (beacon_committee_selections, sync_committee_selections).
 *
 * No Lodestar imports — plain Node http.
 */
import http from "node:http";
import {parseArgs} from "node:util";

const INTEROP_PUBKEYS = [
  "0xa99a76ed7796f7be22d5b7e85deeb7c5677e88e511e0b337618f8c4eb61349b4bf2d153f649f7b53359fe8b94a38e44c",
  "0xb89bebc699769726a318c8e9971bd3171297c61aea4a6578a7a4f94b547dcba5bac16a89108b6b6a1fe3695d1a874a0b",
  "0xa3a32b0f8b4ddb83f1a0a853d81dd725dfe577d4f4c3db8ece52ce2b026eca84815c1a7e8e92a4de3d755733bf7e4a9b",
  "0x88c141df77cd9d8d7a71a75c826c41a9c9f03c6ee1b180f3e7852f6a280099ded351b58d66e653af8e42816a4d8f532e",
];

const ZERO32 = "0x" + "00".repeat(32);
const FAR_EPOCH = "18446744073709551615";

const {values: args} = parseArgs({
  options: {
    port: {type: "string", default: "19596"},
    host: {type: "string", default: "127.0.0.1"},
    "stall-ms": {type: "string", default: "0"}, // 0 = never respond
    "genesis-time": {type: "string", default: ""},
    "slot-duration-ms": {type: "string", default: "6000"},
    "slots-per-epoch": {type: "string", default: "8"},
    verbose: {type: "boolean", default: false},
  },
});

const port = Number(args.port);
const host = args.host;
const stallMs = Number(args["stall-ms"]);
const slotDurationMs = Number(args["slot-duration-ms"]);
const slotsPerEpoch = Number(args["slots-per-epoch"]);
const genesisTime = Number(args["genesis-time"] || Math.floor(Date.now() / 1000) - 2);
const verbose = args.verbose;

/** @type {Set<http.ServerResponse>} */
const sseClients = new Set();
/** @type {Set<http.ServerResponse>} */
const stalledResponses = new Set();

let reqSeq = 0;

function log(...parts) {
  console.log(`[stub-bn ${new Date().toISOString()}]`, ...parts);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function emptyOk(res) {
  res.writeHead(200, {"content-type": "application/json"});
  res.end("{}");
}

function validatorObject(pubkey) {
  return {
    pubkey,
    withdrawal_credentials: ZERO32,
    effective_balance: "32000000000",
    slashed: false,
    activation_eligibility_epoch: "0",
    activation_epoch: "0",
    exit_epoch: FAR_EPOCH,
    withdrawable_epoch: FAR_EPOCH,
  };
}

function currentSlot() {
  return Math.max(0, Math.floor(((Date.now() / 1000) - genesisTime) * 1000 / slotDurationMs));
}

function currentEpoch() {
  return Math.floor(currentSlot() / slotsPerEpoch);
}

function stall(res, label) {
  stalledResponses.add(res);
  res.on("close", () => stalledResponses.delete(res));
  log(`STALL ${label} (stallMs=${stallMs || "forever"}) open=${stalledResponses.size}`);
  if (stallMs > 0) {
    setTimeout(() => {
      if (!res.writableEnded) {
        json(res, 200, {data: []});
        stalledResponses.delete(res);
      }
    }, stallMs);
  }
  // else: never respond — Charon-style hang
}

function handleEvents(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache,no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(":\n\n");
  sseClients.add(res);
  log(`SSE open clients=${sseClients.size} url=${req.url}`);

  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(":\n\n");
  }, 15000);

  const onClose = () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
    log(`SSE closed clients=${sseClients.size}`);
  };
  req.on("close", onClose);
  res.on("close", onClose);
}

function attesterDuties(epoch) {
  const epochNum = Number(epoch);
  const startSlot = epochNum * slotsPerEpoch;
  const data = INTEROP_PUBKEYS.map((pubkey, i) => ({
    pubkey,
    validator_index: String(i),
    committee_index: "0",
    committee_length: "128",
    committees_at_slot: "1",
    validator_committee_index: String(i),
    slot: String(startSlot + (i % slotsPerEpoch)),
  }));
  return {
    dependent_root: ZERO32,
    execution_optimistic: false,
    data,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const id = ++reqSeq;
  const url = new URL(req.url ?? "/", `http://${host}:${port}`);
  const path = url.pathname;
  if (verbose) log(`#${id} ${req.method} ${path}`);

  try {
    // Always consume body so clients don't hang on write
    if (req.method === "POST" || req.method === "PUT") {
      await readBody(req);
    }

    if (req.method === "GET" && path === "/eth/v1/beacon/genesis") {
      return json(res, 200, {
        data: {
          genesis_time: String(genesisTime),
          genesis_validators_root: ZERO32,
          genesis_fork_version: "0x00000001",
        },
      });
    }

    if (req.method === "GET" && path === "/eth/v1/config/spec") {
      // Empty object: Lodestar skips critical-param assert when keys are absent
      return json(res, 200, {data: {}});
    }

    if (req.method === "GET" && path === "/eth/v1/node/syncing") {
      const slot = currentSlot();
      return json(res, 200, {
        data: {
          head_slot: String(slot),
          sync_distance: "0",
          is_syncing: false,
          is_optimistic: false,
          el_offline: false,
        },
      });
    }

    if (req.method === "GET" && path === "/eth/v1/events") {
      return handleEvents(req, res);
    }

    if (
      (req.method === "POST" && path === "/eth/v1/beacon/states/head/validators") ||
      (req.method === "GET" && path.startsWith("/eth/v1/beacon/states/") && path.endsWith("/validators"))
    ) {
      const data = INTEROP_PUBKEYS.map((pubkey, index) => ({
        index: String(index),
        balance: "32000000000",
        status: "active_ongoing",
        validator: validatorObject(pubkey),
      }));
      return json(res, 200, {execution_optimistic: false, finalized: false, data});
    }

    const attesterMatch = path.match(/^\/eth\/v1\/validator\/duties\/attester\/(\d+)$/);
    if (req.method === "POST" && attesterMatch) {
      return json(res, 200, attesterDuties(attesterMatch[1]));
    }

    const proposerMatch = path.match(/^\/eth\/v[12]\/validator\/duties\/proposer\/(\d+)$/);
    if (req.method === "GET" && proposerMatch) {
      return json(res, 200, {
        dependent_root: ZERO32,
        execution_optimistic: false,
        data: [],
      });
    }

    const syncDutyMatch = path.match(/^\/eth\/v1\/validator\/duties\/sync\/(\d+)$/);
    if (req.method === "POST" && syncDutyMatch) {
      return json(res, 200, {execution_optimistic: false, data: []});
    }

    if (req.method === "POST" && path === "/eth/v1/validator/beacon_committee_selections") {
      return stall(res, "beacon_committee_selections");
    }

    if (req.method === "POST" && path === "/eth/v1/validator/sync_committee_selections") {
      return stall(res, "sync_committee_selections");
    }

    if (
      req.method === "POST" &&
      (path === "/eth/v1/validator/beacon_committee_subscriptions" ||
        path === "/eth/v1/validator/sync_committee_subscriptions" ||
        path === "/eth/v1/validator/prepare_beacon_proposer" ||
        path === "/eth/v1/validator/register_validator")
    ) {
      return emptyOk(res);
    }

    // Fallback: empty success for any other beacon API the VC may probe
    if (path.startsWith("/eth/")) {
      if (verbose) log(`#${id} fallback 200 ${path}`);
      return json(res, 200, {data: []});
    }

    json(res, 404, {message: "not found"});
  } catch (e) {
    log(`#${id} error`, e);
    if (!res.headersSent) json(res, 500, {message: String(e)});
  }
});

server.listen(port, host, () => {
  log(`listening http://${host}:${port}`);
  log(`genesisTime=${genesisTime} slotDurationMs=${slotDurationMs} slotsPerEpoch=${slotsPerEpoch}`);
  log(`epoch=${currentEpoch()} slot=${currentSlot()} stallMs=${stallMs || "forever"}`);
});

function shutdown() {
  log(`shutting down sse=${sseClients.size} stalled=${stalledResponses.size}`);
  for (const res of sseClients) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
  for (const res of stalledResponses) {
    try {
      res.destroy();
    } catch {
      /* ignore */
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
