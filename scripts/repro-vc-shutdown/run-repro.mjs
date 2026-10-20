#!/usr/bin/env node
/**
 * Orchestrate VC shutdown hang repro:
 *   1. Start stub BN
 *   2. Start Lodestar validator against it
 *   3. Wait until VC is live (SSE + duties / selections stalled)
 *   4. Send SIGINT or SIGTERM
 *   5. Measure time-to-exit vs bound
 *
 * Exit codes:
 *   0 = VC exited within bound (PASS for patched)
 *   2 = VC exceeded bound / still alive (FAIL for unpatched hang)
 *   1 = setup/orchestration error
 */
import {execFileSync, spawn} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {parseArgs} from "node:util";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

const {values: args} = parseArgs({
  options: {
    signal: {type: "string", default: "SIGINT"},
    boundMs: {type: "string", default: "10000"},
    requestTimeoutMs: {type: "string", default: "60000"},
    readyTimeoutMs: {type: "string", default: "45000"},
    hangWaitMs: {type: "string", default: ""}, // default: boundMs + 5000
    port: {type: "string", default: "19596"},
    label: {type: "string", default: "run"},
    outDir: {type: "string", default: ""},
    dataDir: {type: "string", default: ""},
    lodestarBin: {type: "string", default: "packages/cli/bin/lodestar.js"},
    "skip-stub": {type: "boolean", default: false},
    verbose: {type: "boolean", default: false},
  },
});

const signal = args.signal.toUpperCase();
if (signal !== "SIGINT" && signal !== "SIGTERM") {
  console.error(`unsupported signal ${signal}`);
  process.exit(1);
}

const boundMs = Number(args.boundMs);
const requestTimeoutMs = Number(args.requestTimeoutMs);
const readyTimeoutMs = Number(args.readyTimeoutMs);
const hangWaitMs = Number(args.hangWaitMs || boundMs + 5000);
const port = Number(args.port);
const label = args.label;
const outDir =
  args.outDir || path.join(repoRoot, "repro-logs", label.replace(/[^\w.-]+/g, "_"));
const dataDir = args.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "lodestar-vc-shutdown-"));
const lodestarBin = path.resolve(repoRoot, args.lodestarBin);
const dumpPath = path.join(outDir, "handles.txt");
const vcLogPath = path.join(outDir, "vc.log");
const stubLogPath = path.join(outDir, "stub.log");
const resultPath = path.join(outDir, "result.json");

fs.mkdirSync(outDir, {recursive: true});
fs.mkdirSync(dataDir, {recursive: true});
// Fresh logs every run (reuse of outDir must not see prior ready markers)
for (const f of [vcLogPath, stubLogPath, dumpPath, resultPath, path.join(outDir, "proc-fd.txt")]) {
  try {
    fs.rmSync(f, {force: true});
  } catch {
    /* ignore */
  }
}

const nodeBin = process.execPath;
const dumpPreload = path.join(__dirname, "dump-handles.mjs");
const stubScript = path.join(__dirname, "stub-bn.mjs");

/** @type {import('node:child_process').ChildProcess | null} */
let stubProc = null;
/** @type {import('node:child_process').ChildProcess | null} */
let vcProc = null;
let cleaned = false;

function ts() {
  return new Date().toISOString();
}

function log(...parts) {
  console.log(`[repro ${ts()}]`, ...parts);
}

function appendFile(file, chunk) {
  fs.appendFileSync(file, chunk);
}

function killTree(proc, sig = "SIGKILL") {
  if (!proc?.pid) return;
  try {
    process.kill(-proc.pid, sig);
  } catch {
    try {
      proc.kill(sig);
    } catch {
      /* ignore */
    }
  }
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

function waitForExit(proc, timeoutMs) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve({
        exited: true,
        code: proc.exitCode,
        signal: proc.signalCode,
        elapsedMs: 0,
      });
      return;
    }
    const t0 = Date.now();
    const onExit = (code, sig) => {
      clearTimeout(timer);
      resolve({exited: true, code, signal: sig, elapsedMs: Date.now() - t0});
    };
    const timer = setTimeout(() => {
      proc.off("exit", onExit);
      resolve({exited: false, code: null, signal: null, elapsedMs: Date.now() - t0});
    }, timeoutMs);
    proc.once("exit", onExit);
  });
}

function spawnLogged(cmd, cmdArgs, logFile, {detached = true} = {}) {
  const proc = spawn(cmd, cmdArgs, {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached,
  });
  const onChunk = (buf) => {
    const s = buf.toString("utf8");
    appendFile(logFile, s);
    if (args.verbose) process.stdout.write(s);
  };
  proc.stdout.on("data", onChunk);
  proc.stderr.on("data", onChunk);
  return proc;
}

async function waitForReady(logFile, timeoutMs) {
  const needles = [
    "Submitting partial beacon committee selection proofs",
    "Validator seen on beacon chain",
    "Verified connected to chain",
    "Node is synced",
  ];
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (vcProc?.exitCode !== null && vcProc?.exitCode !== undefined) {
      throw new Error(`VC exited early code=${vcProc.exitCode}; see ${logFile}`);
    }
    if (fs.existsSync(logFile)) {
      const text = fs.readFileSync(logFile, "utf8");
      for (const n of needles) {
        if (text.includes(n)) return n;
      }
      // Also ready if stub logged a stall (selections hit)
      if (fs.existsSync(stubLogPath) && fs.readFileSync(stubLogPath, "utf8").includes("STALL beacon_committee_selections")) {
        return "stub-stall-beacon_committee_selections";
      }
    }
    await sleep(200);
  }
  throw new Error(`VC not ready within ${timeoutMs}ms; see ${logFile}`);
}

async function cleanup(extraSig = "SIGKILL") {
  if (cleaned) return;
  cleaned = true;
  if (vcProc && vcProc.exitCode === null && vcProc.signalCode === null) killTree(vcProc, extraSig);
  if (stubProc && stubProc.exitCode === null && stubProc.signalCode === null) killTree(stubProc, "SIGTERM");
  await sleep(200);
  if (stubProc && stubProc.exitCode === null) killTree(stubProc, "SIGKILL");
}

process.on("exit", () => {
  // best-effort
  try {
    if (vcProc && vcProc.exitCode === null) killTree(vcProc, "SIGKILL");
    if (stubProc && stubProc.exitCode === null) killTree(stubProc, "SIGKILL");
  } catch {
    /* ignore */
  }
});

async function main() {
  log(`label=${label} signal=${signal} boundMs=${boundMs} requestTimeoutMs=${requestTimeoutMs}`);
  log(`outDir=${outDir}`);
  log(`dataDir=${dataDir}`);
  log(`lodestarBin=${lodestarBin}`);

  if (!fs.existsSync(lodestarBin)) {
    throw new Error(`lodestar bin missing: ${lodestarBin} (build packages/cli first)`);
  }

  if (!args["skip-stub"]) {
    stubProc = spawnLogged(
      nodeBin,
      [stubScript, "--port", String(port), "--verbose"],
      stubLogPath
    );
    log(`stub pid=${stubProc.pid}`);
    await sleep(400);
    if (stubProc.exitCode !== null) throw new Error(`stub exited early code=${stubProc.exitCode}`);
  }

  const vcArgs = [
    "--import",
    dumpPreload,
    lodestarBin,
    "validator",
    "--network=dev",
    `--server=http://127.0.0.1:${port}`,
    "--interopIndexes=0..3",
    "--distributed",
    `--dataDir=${dataDir}`,
    `--http.requestTimeout=${requestTimeoutMs}`,
    "--logLevel=debug",
    "--logFileLevel=debug",
    `--logFile=${path.join(dataDir, "validator.log")}`,
  ];

  const vcEnv = {
    ...process.env,
    VC_HANDLE_DUMP: dumpPath,
    VC_HANDLE_DUMP_DELAY_MS: "1500",
    VC_HANDLE_DUMP_INTERVAL_MS: "2000",
    VC_HANDLE_DUMP_COUNT: "4",
  };

  vcProc = spawn(nodeBin, vcArgs, {
    cwd: repoRoot,
    env: vcEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const onChunk = (buf) => {
    const s = buf.toString("utf8");
    appendFile(vcLogPath, s);
    if (args.verbose) process.stdout.write(s);
  };
  vcProc.stdout.on("data", onChunk);
  vcProc.stderr.on("data", onChunk);
  log(`vc pid=${vcProc.pid}`);

  const readyMarker = await waitForReady(vcLogPath, readyTimeoutMs);
  log(`ready marker: ${readyMarker}`);

  // Give selections / SSE a moment to settle into the hung state
  await sleep(1500);

  const aliveBefore = vcProc.exitCode === null && vcProc.signalCode === null;
  if (!aliveBefore) throw new Error("VC already exited before signal");

  log(`sending ${signal} to pid=${vcProc.pid}`);
  const tSignal = Date.now();
  process.kill(vcProc.pid, signal);

  const wait = await waitForExit(vcProc, hangWaitMs);
  const exitMs = wait.exited ? wait.elapsedMs : Date.now() - tSignal;
  const withinBound = wait.exited && exitMs <= boundMs;
  const verdict = withinBound ? "PASS_EXIT_WITHIN_BOUND" : wait.exited ? "FAIL_EXIT_SLOW" : "FAIL_HUNG";

  // If hung, capture /proc fd list + stub state for evidence
  let procFdSample = null;
  let stillAlive = !wait.exited;
  if (stillAlive && vcProc.pid) {
    try {
      const fdDir = `/proc/${vcProc.pid}/fd`;
      const fds = fs.readdirSync(fdDir).slice(0, 64);
      procFdSample = fds.map((fd) => {
        try {
          return `${fd} -> ${fs.readlinkSync(path.join(fdDir, fd))}`;
        } catch (e) {
          return `${fd} -> (${e.code || e.message})`;
        }
      });
      appendFile(path.join(outDir, "proc-fd.txt"), procFdSample.join("\n") + "\n");
    } catch (e) {
      procFdSample = [`error: ${e.message}`];
    }
    // Force kill so the orchestrator can finish
    log(`VC still alive after ${exitMs}ms — SIGKILL`);
    killTree(vcProc, "SIGKILL");
    await waitForExit(vcProc, 3000);
  }

  const result = {
    label,
    signal,
    boundMs,
    requestTimeoutMs,
    readyMarker,
    exitMs,
    exited: wait.exited,
    exitCode: wait.code,
    exitSignal: wait.signal,
    withinBound,
    verdict,
    vcPid: vcProc.pid,
    gitHead: (() => {
      try {
        return execFileSync("git", ["rev-parse", "HEAD"], {cwd: repoRoot, encoding: "utf8"}).trim();
      } catch {
        return null;
      }
    })(),
    outDir,
    dumpPath: fs.existsSync(dumpPath) ? dumpPath : null,
    procFdSample,
    stubLog: stubLogPath,
    vcLog: vcLogPath,
  };

  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
  log(`verdict=${verdict} exitMs=${exitMs} withinBound=${withinBound}`);
  log(`result written ${resultPath}`);

  await cleanup();

  if (verdict === "PASS_EXIT_WITHIN_BOUND") process.exit(0);
  process.exit(2);
}

main().catch(async (e) => {
  console.error(`[repro] ERROR`, e);
  await cleanup();
  process.exit(1);
});
