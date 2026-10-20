#!/usr/bin/env node
/**
 * Build/run shutdown repro across patch variants.
 *
 * Expects to be run from a worktree where variant patches can be applied.
 * Prefer scripts/repro-vc-shutdown/apply-variant.mjs + external orchestration;
 * this file runs N trials for the *currently checked-out* tree.
 *
 * Usage:
 *   node scripts/repro-vc-shutdown/run-matrix.mjs --label <name> --runs 3
 */
import {spawn} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {parseArgs} from "node:util";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

const {values: args} = parseArgs({
  options: {
    label: {type: "string", default: "current"},
    runs: {type: "string", default: "3"},
    boundMs: {type: "string", default: "10000"},
    requestTimeoutMs: {type: "string", default: "60000"},
    hangWaitMs: {type: "string", default: "20000"},
    signals: {type: "string", default: "SIGINT,SIGTERM"},
    outRoot: {
      type: "string",
      default: "/opt/cursor/artifacts/lodestar-vc-shutdown/logs",
    },
  },
});

const runs = Number(args.runs);
const signals = args.signals.split(",").map((s) => s.trim()).filter(Boolean);
const summary = [];

function runOnce(label, signal, runIdx) {
  return new Promise((resolve) => {
    const outDir = path.join(args.outRoot, `${label}-${signal}-r${runIdx}`);
    const port = 19596 + (runIdx % 20) + (signal === "SIGTERM" ? 40 : 0);
    const child = spawn(
      process.execPath,
      [
        path.join(__dirname, "run-repro.mjs"),
        "--label",
        `${label}-${signal}-r${runIdx}`,
        "--signal",
        signal,
        "--boundMs",
        args.boundMs,
        "--requestTimeoutMs",
        args.requestTimeoutMs,
        "--hangWaitMs",
        args.hangWaitMs,
        "--port",
        String(port),
        "--outDir",
        outDir,
      ],
      {cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"]}
    );
    let out = "";
    child.stdout.on("data", (b) => {
      out += b.toString();
      process.stdout.write(b);
    });
    child.stderr.on("data", (b) => {
      out += b.toString();
      process.stderr.write(b);
    });
    child.on("exit", (code) => {
      const resultPath = path.join(outDir, "result.json");
      let result = null;
      if (fs.existsSync(resultPath)) {
        result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      }
      resolve({code, result, outDir});
    });
  });
}

async function main() {
  for (const signal of signals) {
    for (let i = 1; i <= runs; i++) {
      console.log(`\n======== ${args.label} ${signal} run ${i}/${runs} ========`);
      const {code, result, outDir} = await runOnce(args.label, signal, i);
      summary.push({
        label: args.label,
        signal,
        run: i,
        exitCode: code,
        exitMs: result?.exitMs ?? null,
        verdict: result?.verdict ?? "ORCH_ERROR",
        withinBound: result?.withinBound ?? false,
        outDir,
      });
    }
  }

  const summaryPath = path.join(args.outRoot, `${args.label}-summary.json`);
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`\nSummary written ${summaryPath}`);
  console.table(summary.map(({label, signal, run, exitMs, verdict, withinBound}) => ({label, signal, run, exitMs, verdict, withinBound})));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
