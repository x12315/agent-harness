#!/usr/bin/env node
/**
 * One entry point for the harness checks.
 *
 *   node scripts/harness.mjs [command] [--apply] [--all] [--json]
 *
 *   compose     compile instruction/profile sources (check unless --apply)
 *   profile     inspect a declared profile: harness.mjs profile [name]
 *   bootstrap   project the repo into the harness paths (dry run unless --apply)
 *   restore     delegate declared skills/adapter dependencies to their installers
 *   reconcile   declaration vs reality, gated by scripts/expected-gaps.json
 *   drift       recorded well-known digests vs the upstream index (network)
 *   verify      pi discovery, codex entry, projection and repo hygiene
 *   secrets     credential scan of tracked files (--staged / --history also work)
 *   all         bootstrap -> reconcile -> verify   (default)
 *   install     the official one-shot for a new machine:
 *               bootstrap --apply -> restore --apply -> reconcile -> verify
 *
 * `install` is the method to document and to run on a fresh machine; `all` is
 * the check-only entry you run after any edit.
 *
 * Everything is read-only unless --apply is given, and every step is
 * idempotent, so re-running is always safe.
 */
import { run as bootstrap, nextSteps } from "./bootstrap.mjs";
import { inspect as inspectProfile, run as compose } from "./compose.mjs";
import { run as drift } from "./drift.mjs";
import { run as reconcile } from "./reconcile.mjs";
import { run as secretScan } from "./secret-scan.mjs";
import { run as restore } from "./restore.mjs";
import { run as verify } from "./verify.mjs";

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("-"));
const command = positional[0] ?? "all";
const options = { apply: argv.includes("--apply"), all: argv.includes("--all"), json: argv.includes("--json") };
const runners = { compose, bootstrap, restore, reconcile, drift, verify, secrets: secretScan };

const heading = (text) => process.stdout.write(`\n== ${text}\n`);

let code = 0;
if (command === "profile") {
  try { inspectProfile(positional[1], options); }
  catch (error) { process.stderr.write(`profile: ${error.message}\n`); code = 1; }
} else if (command === "install") {
  // The official path for a fresh machine. Applying is the point of the
  // command, so it forces --apply rather than asking for it twice.
  heading("compose");
  if (compose(options) !== 0) code = 1;
  heading("bootstrap (applying)");
  if (bootstrap({ ...options, apply: true }) !== 0) code = 1;
  heading("restore (applying)");
  if (restore({ ...options, apply: true }) !== 0) code = 1;
  if (!options.json) {
    heading("reconcile");
    if (reconcile(options) !== 0) code = 1;
    heading("secrets");
    if (secretScan(options) !== 0) code = 1;
    heading("verify");
    if (verify(options) !== 0) code = 1;
  }
} else if (command === "all") {
  heading(`compose${options.apply ? " (applying)" : ""}`);
  if (compose(options) !== 0) code = 1;
  heading(`bootstrap${options.apply ? " (applying)" : " (dry run)"}`);
  if (bootstrap(options) !== 0) {
    code = 1;
    for (const step of nextSteps()) process.stdout.write(`  next: ${step}\n`);
  }
  if (!options.json) {
    heading("reconcile");
    if (reconcile(options) !== 0) code = 1;
    heading("secrets");
    if (secretScan(options) !== 0) code = 1;
    heading("verify");
    if (verify(options) !== 0) code = 1;
  }
} else if (Object.hasOwn(runners, command)) {
  code = (await runners[command](options)) ?? 0;
} else {
  process.stderr.write(`unknown command: ${command}\nusage: harness.mjs <compose|profile [name]|bootstrap|restore|reconcile|drift|verify|secrets|all|install> [--apply] [--all] [--json]\n`);
  code = 2;
}
process.exit(code);
