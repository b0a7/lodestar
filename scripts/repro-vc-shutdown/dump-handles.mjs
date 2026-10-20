/**
 * Preload for the validator process. After the first SIGINT/SIGTERM, dump
 * Node active handles/requests a few times so hung runs leave evidence.
 *
 * Usage: node --import ./dump-handles.mjs packages/cli/bin/lodestar.js validator ...
 */
import fs from "node:fs";
import process from "node:process";

const outPath = process.env.VC_HANDLE_DUMP ?? "";
const dumpDelayMs = Number(process.env.VC_HANDLE_DUMP_DELAY_MS ?? "2000");
const dumpIntervalMs = Number(process.env.VC_HANDLE_DUMP_INTERVAL_MS ?? "2000");
const dumpCount = Number(process.env.VC_HANDLE_DUMP_COUNT ?? "3");

let dumping = false;

function describeHandle(h) {
  if (h == null) return String(h);
  const type = h.constructor?.name ?? typeof h;
  const bits = [type];
  if (typeof h.fd === "number") bits.push(`fd=${h.fd}`);
  if (typeof h.address === "function") {
    try {
      bits.push(`addr=${JSON.stringify(h.address())}`);
    } catch {
      /* ignore */
    }
  }
  if (typeof h.remoteAddress === "string") bits.push(`remote=${h.remoteAddress}:${h.remotePort}`);
  if (typeof h.localAddress === "string") bits.push(`local=${h.localAddress}:${h.localPort}`);
  if (typeof h._httpMessage?.method === "string") {
    bits.push(`http=${h._httpMessage.method} ${h._httpMessage.path ?? ""}`);
  }
  if (typeof h.url === "string") bits.push(`url=${h.url}`);
  if (typeof h._idleTimeout === "number") bits.push(`idleTimeout=${h._idleTimeout}`);
  if (typeof h.hasRef === "function") bits.push(`ref=${h.hasRef()}`);
  return bits.join(" ");
}

function dumpOnce(tag) {
  const handles = (process._getActiveHandles?.() ?? []).map(describeHandle);
  const requests = (process._getActiveRequests?.() ?? []).map(describeHandle);
  const body = [
    `=== handle dump ${tag} pid=${process.pid} t=${new Date().toISOString()} ===`,
    `activeHandles=${handles.length}`,
    ...handles.map((h, i) => `  H[${i}] ${h}`),
    `activeRequests=${requests.length}`,
    ...requests.map((r, i) => `  R[${i}] ${r}`),
    "",
  ].join("\n");

  process.stderr.write(body);
  if (outPath) {
    fs.appendFileSync(outPath, body);
  }
}

function startDumping(signal) {
  if (dumping) return;
  dumping = true;
  dumpOnce(`immediate-after-${signal}`);
  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    dumpOnce(`${signal}-plus-${dumpDelayMs + (n - 1) * dumpIntervalMs}ms`);
    if (n >= dumpCount) clearInterval(timer);
  }, dumpIntervalMs);
  // Keep timer from being the sole reason the process stays alive once everything else is gone
  timer.unref?.();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    // Do not prevent default handlers; only observe.
    setTimeout(() => startDumping(signal), dumpDelayMs).unref?.();
  });
}

process.stderr.write(`[dump-handles] preload active dumpPath=${outPath || "(stderr only)"}\n`);
