#!/usr/bin/env node
/**
 * One entry point for the harness checks.
 *
 *   harness [command] [--apply] [--all] [--json]
 *
 *   status      show the human-facing control plane (default)
 *   profile     list/show/edit declared profiles
 *   pi          launch switch-ready ordinary Pi with native arguments
 *   run         launch Pi or Codex with a declared profile
 *   web         open the local Harness composition workbench
 *   apply       compose, project, and verify
 *   doctor      run the read-only full verification
 *   benchmark   measure full doctor serial/parallel performance and compare release reports
 *   compose     compile instruction/profile sources (check unless --apply)
 *   bootstrap   project the repo into the harness paths (dry run unless --apply)
 *   restore     delegate declared skills/adapter dependencies to their installers
 *   reconcile   declaration vs reality, gated by scripts/expected-gaps.json
 *   drift       recorded well-known digests vs the upstream index (network)
 *   verify      pi discovery, codex entry, projection and repo hygiene
 *   secrets     credential scan of tracked files (--staged / --history also work)
 *   all         backward-compatible full verification command
 *   install     the official one-shot for a new machine:
 *               bootstrap --apply -> restore --apply -> reconcile -> verify
 *
 * `install` is the bootstrap entry on a fresh machine. After projection,
 * humans use `harness`; automation may keep using the low-level commands.
 *
 * Everything is read-only unless --apply is given, and every step is
 * idempotent, so re-running is always safe.
 */
import { run as bootstrap, nextSteps } from "./bootstrap.mjs";
import { run as compose } from "./compose.mjs";
import { run as drift } from "./drift.mjs";
import { run as reconcile } from "./reconcile.mjs";
import { run as secretScan } from "./secret-scan.mjs";
import { run as restore } from "./restore.mjs";
import { run as verify, verificationOptions } from "./verify.mjs";
import { editProfile, help, runPi, runProfile, showProfilePath, showProfiles, showStatus } from "./manage.mjs";

import { CATALOG, catalogArguments } from "./lib/repo.mjs";
const argv = catalogArguments().args;
process.env.HARNESS_CATALOG = CATALOG;
const command = ["--help", "-h"].includes(argv[0]) ? "help" : argv[0]?.startsWith("-") ? "status" : argv[0] ?? "status";
const options = { apply: argv.includes("--apply"), all: argv.includes("--all"), json: argv.includes("--json"), serial: argv.includes("--serial"), staged: argv.includes("--staged"), history: argv.includes("--history"), scanRoot: argv.find((arg) => arg.startsWith("--scan-root="))?.slice(12) };
const runners = { compose, bootstrap, restore, reconcile, drift, verify, secrets: secretScan };
const heading = (text) => process.stdout.write(`\n== ${text}\n`);

async function runChecks(runOptions) {
  let result = 0;
  heading(`compose${runOptions.apply ? " (applying)" : ""}`);
  if (compose(runOptions) !== 0) result = 1;
  heading(`bootstrap${runOptions.apply ? " (applying)" : " (dry run)"}`);
  if (bootstrap(runOptions) !== 0) {
    result = 1;
    for (const step of nextSteps()) process.stdout.write(`  next: ${step}\n`);
  }
  heading("reconcile");
  if (reconcile(runOptions) !== 0) result = 1;
  heading("secrets");
  if (secretScan(runOptions) !== 0) result = 1;
  heading("verify");
  if (await verify(runOptions) !== 0) result = 1;
  return result;
}

let code = 0;
if (command === "status") {
  code = showStatus(options);
} else if (command === "help" || command === "--help" || command === "-h") {
  code = help();
} else if (command === "profile") {
  const action = argv[1];
  if (!action || action === "list") code = showProfiles(undefined, options);
  else if (action === "show") code = showProfiles(argv[2], options);
  else if (action === "path") code = showProfilePath(argv[2]);
  else if (action === "edit") {
    code = editProfile(argv[2]);
    if (code === 0) code = await runChecks({ ...options, apply: true });
  } else {
    // Backward-compatible shorthand: `harness profile review`.
    code = showProfiles(action, options);
  }
} else if (command === "pi") {
  code = await runPi(argv.slice(1));
} else if (command === "run") {
  code = runProfile(argv[1], argv[2], argv.slice(3));
} else if (command === "web") {
  const { runHarnessWeb } = await import("./web.mjs");
  const portArg = argv.find((argument) => argument.startsWith("--port="));
  await runHarnessWeb({
    port: portArg ? Number(portArg.slice("--port=".length)) : 0,
    open: !argv.includes("--no-open"),
  });
} else if (command === "benchmark") {
  const { run } = await import("./benchmark-doctor.mjs");
  code = await run(argv.slice(1));
} else if (command === "apply") {
  code = await runChecks({ ...options, apply: true });
} else if (command === "doctor" || command === "all") {
  code = await runChecks({ ...options, apply: command === "all" && options.apply });
} else if (command === "install") {
  // The first install cannot use the projected `harness` executable yet.
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
    if (await verify(options) !== 0) code = 1;
  }
} else if (command === "verify") {
  try { code = await verify({ ...options, ...verificationOptions(argv.slice(1)) }); }
  catch (error) { console.error(error.message); code = 2; }
} else if (Object.hasOwn(runners, command)) {
  code = (await runners[command](options)) ?? 0;
} else {
  process.stderr.write(`unknown command: ${command}\n`);
  help();
  code = 2;
}
if (command !== "web") process.exit(code);
