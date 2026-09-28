#!/usr/bin/env node
/**
 * Project this repo into the harness native paths.
 *
 * Dry run by default - pass --apply to write. Idempotent: a projection that
 * already points at the right file is left alone, and a real file or directory
 * in the way is reported as a conflict instead of being deleted.
 *
 * Exit 0 only when every projection is in place afterwards.
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, managedLinks, pins, relTarget } from "./lib/repo.mjs";

/**
 * Relative link target computed from the directory's REAL path.
 *
 * On macOS /tmp is a symlink to /private/tmp, so a textual relative path
 * between a /tmp projection and a realpath'd repo would climb to the filesystem
 * root and come back down ("../../../../../../../private/tmp/..."). Resolving
 * the parent first keeps the link short and stays correct wherever the pair is
 * moved together.
 */
export function run({ apply = false, json = false } = {}) {
  const actions = [];
  for (const [src, target] of managedLinks()) {
    const source = join(REPO, src);
    const record = (action, detail) => actions.push({ source: src, target, action, detail });

    if (!existsSync(source)) { record("skip", "source missing in repo"); continue; }
    mkdirSync(dirname(target), { recursive: true });
    let realDir = dirname(target);
    try { realDir = realpathSync(dirname(target)); } catch { /* keep literal */ }
    const want = relTarget(realDir, source);

    if (!existsSync(target)) {
      record("create", want);
      if (apply) symlinkSync(want, target);
      continue;
    }
    if (lstatSync(target).isSymbolicLink()) {
      const current = readlinkSync(target);
      if (current === want) { record("ok", current); continue; }
      record("fix", `${current} -> ${want}`);
      if (apply) { rmSync(target, { force: true }); symlinkSync(want, target); }
      continue;
    }
    record(
      "conflict",
      lstatSync(target).isDirectory()
        ? "a real directory is in the way; move it aside, then re-run"
        : "a real file is in the way; inspect it, then re-run",
    );
  }

  const counts = actions.reduce((acc, a) => ((acc[a.action] = (acc[a.action] ?? 0) + 1), acc), {});
  // After --apply the create/fix actions are done, so only conflicts and skips
  // are failures; in dry-run mode anything not already ok is pending work.
  const ok = apply
    ? (counts.conflict ?? 0) === 0 && (counts.skip ?? 0) === 0
    : (counts.ok ?? 0) === actions.length;

  if (json) {
    console.log(JSON.stringify({ ok, apply, counts, actions }, null, 2));
  } else {
    for (const a of actions) {
      const mark = { ok: "ok  ", create: apply ? "made" : "todo", fix: apply ? "fixed" : "todo", skip: "SKIP", conflict: "FAIL" }[a.action];
      console.log(`${mark}  ${a.target}  ${a.action === "ok" ? "" : `(${a.detail})`}`);
    }
    console.log(`projections: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}${apply ? "" : "  [dry run]"}`);
    if (!ok && !apply) console.log(`re-run with --apply to write the ${(counts.create ?? 0) + (counts.fix ?? 0)} pending projection(s)`);
    if (!ok && apply) console.log("bootstrap: FAILED - resolve the conflicts/skips above");
    else console.log(ok ? "bootstrap: OK" : "bootstrap: pending");
  }
  return ok ? 0 : 1;
}

export function nextSteps() {
  const { skillsCli } = pins();
  return [
    `restore the declared third-party skills: node scripts/restore.mjs --apply   (pinned skills CLI ${skillsCli})`,
    "then: node scripts/harness.mjs reconcile",
    "then: node scripts/harness.mjs verify",
  ];
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(run({ apply: process.argv.includes("--apply"), json: process.argv.includes("--json") }));
