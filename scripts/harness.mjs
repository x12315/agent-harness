#!/usr/bin/env node
/**
 * One entry point for the harness checks.
 *
 *   node scripts/harness.mjs [command] [--apply] [--all] [--json]
 *
 *   bootstrap   project the repo into the harness paths (dry run unless --apply)
 *   restore     install the declared third-party skills from the lock (plan unless --apply)
 *   reconcile   declaration vs reality, gated by scripts/expected-gaps.json
 *   drift       recorded well-known digests vs the upstream index (network)
 *   verify      pi discovery, claude entry, projection and repo hygiene
 *   all         bootstrap -> reconcile -> verify   (default)
 *
 * Everything is read-only unless --apply is given, and every step is
 * idempotent, so re-running is always safe.
 */
import { run as bootstrap, nextSteps } from "./bootstrap.mjs";
import { run as drift } from "./drift.mjs";
import { run as reconcile } from "./reconcile.mjs";
import { run as restore } from "./restore.mjs";
import { run as verify } from "./verify.mjs";

const argv = process.argv.slice(2);
const command = argv.find((a) => !a.startsWith("-")) ?? "all";
const options = { apply: argv.includes("--apply"), all: argv.includes("--all"), json: argv.includes("--json") };
const runners = { bootstrap, restore, reconcile, drift, verify };

const heading = (text) => process.stdout.write(`\n== ${text}\n`);

let code = 0;
if (command === "all") {
  heading(`bootstrap${options.apply ? " (applying)" : " (dry run)"}`);
  if (bootstrap(options) !== 0) {
    code = 1;
    for (const step of nextSteps()) process.stdout.write(`  next: ${step}\n`);
  }
  if (!options.json) {
    heading("reconcile");
    if (reconcile(options) !== 0) code = 1;
    heading("verify");
    if (verify(options) !== 0) code = 1;
  }
} else if (Object.hasOwn(runners, command)) {
  code = (await runners[command](options)) ?? 0;
} else {
  process.stderr.write(`unknown command: ${command}\nusage: harness.mjs <bootstrap|restore|reconcile|drift|verify|all> [--apply] [--all] [--json]\n`);
  code = 2;
}
process.exit(code);
