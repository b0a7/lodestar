#!/usr/bin/env node
/**
 * Apply each patch variant, rebuild touched packages, run SIGINT/SIGTERM trials.
 */
import {execFileSync, spawnSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {parseArgs} from "node:util";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

const {values: args} = parseArgs({
  options: {
    runs: {type: "string", default: "3"},
    boundMs: {type: "string", default: "10000"},
    requestTimeoutMs: {type: "string", default: "60000"},
    hangWaitMs: {type: "string", default: "20000"},
    variants: {
      type: "string",
      // none, singles, useful pairs, full
      default: "none,A,B,C,A+B,A+C,B+C,A+B+C",
    },
    outRoot: {
      type: "string",
      default: "/opt/cursor/artifacts/lodestar-vc-shutdown/logs",
    },
  },
});

const variants = args.variants.split(",").map((s) => s.trim()).filter(Boolean);
const allRows = [];

function sh(cmd, cmdArgs, opts = {}) {
  console.log(`$ ${cmd} ${cmdArgs.join(" ")}`);
  execFileSync(cmd, cmdArgs, {cwd: repoRoot, stdio: "inherit", ...opts});
}

function buildFor(letters) {
  const filters = new Set(["@chainsafe/lodestar"]);
  if (letters.includes("B") || letters.includes("A") || letters.includes("C") || letters.length === 0) {
    // always rebuild cli; rebuild deps when their sources change
  }
  if (letters.includes("B")) filters.add("@lodestar/api");
  if (letters.includes("C")) filters.add("@lodestar/validator");
  // none / A still needs cli rebuild if we toggled A off after a previous variant
  filters.add("@lodestar/api");
  filters.add("@lodestar/validator");
  filters.add("@chainsafe/lodestar");
  for (const f of filters) {
    sh("pnpm", ["--filter", f, "build"]);
  }
}

for (const variant of variants) {
  const letters = variant.toUpperCase() === "NONE" ? [] : variant.split("+").map((s) => s.trim().toUpperCase());
  const label = variant.toUpperCase() === "NONE" ? "none" : letters.join("+");
  console.log(`\n##############################`);
  console.log(`# VARIANT ${label}`);
  console.log(`##############################`);

  sh(process.execPath, [
    path.join(__dirname, "apply-variant.mjs"),
    ...(letters.length ? letters : ["none"]),
  ]);
  buildFor(letters);

  const summaryPath = path.join(args.outRoot, `${label}-summary.json`);
  const r = spawnSync(
    process.execPath,
    [
      path.join(__dirname, "run-matrix.mjs"),
      "--label",
      label,
      "--runs",
      args.runs,
      "--boundMs",
      args.boundMs,
      "--requestTimeoutMs",
      args.requestTimeoutMs,
      "--hangWaitMs",
      args.hangWaitMs,
      "--outRoot",
      args.outRoot,
    ],
    {cwd: repoRoot, stdio: "inherit"}
  );
  if (r.status && r.status > 1) {
    console.error(`matrix orchestrator failed for ${label} status=${r.status}`);
  }
  if (fs.existsSync(summaryPath)) {
    allRows.push(...JSON.parse(fs.readFileSync(summaryPath, "utf8")));
  }
}

// restore clean tree for PR-touched files
sh(process.execPath, [path.join(__dirname, "apply-variant.mjs"), "none"]);

const aggregatePath = path.join(
  "/opt/cursor/artifacts/lodestar-vc-shutdown",
  "variant-aggregate.json"
);
fs.writeFileSync(aggregatePath, JSON.stringify(allRows, null, 2));

// compact table
const byKey = new Map();
for (const row of allRows) {
  const key = `${row.label}|${row.signal}`;
  if (!byKey.has(key)) byKey.set(key, []);
  byKey.get(key).push(row.exitMs);
}
const table = [];
for (const [key, times] of byKey) {
  const [label, signal] = key.split("|");
  const nums = times.filter((t) => typeof t === "number");
  const avg = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  const max = nums.length ? Math.max(...nums) : null;
  const min = nums.length ? Math.min(...nums) : null;
  const pass = allRows
    .filter((r) => r.label === label && r.signal === signal)
    .every((r) => r.withinBound);
  table.push({label, signal, runs: nums.length, minMs: min, avgMs: avg && Math.round(avg), maxMs: max, allWithinBound: pass});
}
fs.writeFileSync(
  path.join("/opt/cursor/artifacts/lodestar-vc-shutdown", "variant-table.json"),
  JSON.stringify(table, null, 2)
);
console.log("\n=== AGGREGATE ===");
console.table(table);
console.log(`wrote ${aggregatePath}`);
