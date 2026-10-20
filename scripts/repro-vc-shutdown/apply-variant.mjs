#!/usr/bin/env node
/**
 * Reset to unstable merge-base (keeping harness files) and apply selected
 * patch letters: A=process.exit, B=HttpClient abort, C=selections timeout.
 *
 * Usage:
 *   node scripts/repro-vc-shutdown/apply-variant.mjs none
 *   node scripts/repro-vc-shutdown/apply-variant.mjs A
 *   node scripts/repro-vc-shutdown/apply-variant.mjs B C
 *   node scripts/repro-vc-shutdown/apply-variant.mjs A B C
 */
import {execFileSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const patchesDir = path.join(__dirname, "patches");

const MAP = {
  A: "A-process-exit.patch",
  B: "B-httpclient-abort.patch",
  C: "C-selections-timeout.patch",
};

const letters = process.argv.slice(2).map((s) => s.toUpperCase()).filter((s) => s !== "NONE");
if (process.argv[2] === undefined) {
  console.error("usage: apply-variant.mjs none|A [B] [C]");
  process.exit(1);
}

for (const L of letters) {
  if (!MAP[L]) {
    console.error(`unknown variant letter ${L}`);
    process.exit(1);
  }
}

function sh(cmd, cmdArgs) {
  execFileSync(cmd, cmdArgs, {cwd: repoRoot, stdio: "inherit"});
}

// Restore PR-touched files to HEAD (harness branch / unstable), then apply
const touched = [
  "packages/cli/src/cmds/validator/handler.ts",
  "packages/api/src/utils/client/httpClient.ts",
  "packages/api/test/unit/client/httpClient.test.ts",
  "packages/validator/src/services/attestationDuties.ts",
  "packages/validator/test/unit/services/attestationDuties.test.ts",
];
sh("git", ["checkout", "HEAD", "--", ...touched]);

for (const L of letters) {
  const patch = path.join(patchesDir, MAP[L]);
  if (!fs.existsSync(patch)) throw new Error(`missing ${patch}`);
  console.log(`applying ${MAP[L]}`);
  sh("git", ["apply", patch]);
}

console.log(`variant active: ${letters.length ? letters.join("+") : "none"}`);
