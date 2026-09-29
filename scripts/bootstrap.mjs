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
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ENGINEERING_SETTING_KEYS, LOCAL_PI_SETTINGS, REPO, engineeringPiSettings, managedLinks, pins, relTarget } from "./lib/repo.mjs";

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

  // Engineering vs personalization. The shared declaration carries only
  // engineering keys (packages); the machine keeps its own model/provider/theme
  // in a real local file. bootstrap merges the engineering keys in and leaves
  // everything else alone, so two machines never overwrite each other's choices.
  const settingsActions = mergeSettings({ apply });

  const counts = actions.reduce((acc, a) => ((acc[a.action] = (acc[a.action] ?? 0) + 1), acc), {});
  // After --apply the create/fix actions are done, so only conflicts and skips
  // are failures; in dry-run mode anything not already ok is pending work.
  const settingsOk = settingsActions.every((a) => a.action === "ok");
  const ok = apply
    ? (counts.conflict ?? 0) === 0 && (counts.skip ?? 0) === 0 && settingsActions.every((a) => a.action !== "conflict")
    : (counts.ok ?? 0) === actions.length && settingsOk;

  if (json) {
    console.log(JSON.stringify({ ok, apply, counts, actions }, null, 2));
  } else {
    for (const a of actions) {
      const mark = { ok: "ok  ", create: apply ? "made" : "todo", fix: apply ? "fixed" : "todo", skip: "SKIP", conflict: "FAIL" }[a.action];
      console.log(`${mark}  ${a.target}  ${a.action === "ok" ? "" : `(${a.detail})`}`);
    }
    for (const a of settingsActions) {
      const mark = { ok: "ok  ", create: apply ? "made" : "todo", convert: apply ? "conv" : "todo", merge: apply ? "mrge" : "todo" }[a.action];
      console.log(`${mark}  ${a.target}  ${a.action === "ok" ? "" : `(${a.detail})`}`);
    }
    console.log(`projections: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}${apply ? "" : "  [dry run]"}`);
    if (!ok && !apply) console.log(`re-run with --apply to write the ${(counts.create ?? 0) + (counts.fix ?? 0)} pending projection(s)`);
    if (!ok && apply) console.log("bootstrap: FAILED - resolve the conflicts/skips above");
    else console.log(ok ? "bootstrap: OK" : "bootstrap: pending");
  }
  return ok ? 0 : 1;
}

/**
 * Merge the engineering declaration into the machine-local settings.
 *
 * A legacy projection (symlink into the repo) is converted to a real file: a
 * symlink cannot carry per-machine values, which is exactly the bug this fixes.
 * Returns the same action records shape as the projection loop.
 */
export function mergeSettings({ apply = false } = {}) {
  const engineering = engineeringPiSettings();

  const legacy = existsSync(LOCAL_PI_SETTINGS) && lstatSync(LOCAL_PI_SETTINGS).isSymbolicLink();
  let personal = {};
  if (existsSync(LOCAL_PI_SETTINGS)) {
    try {
      const current = JSON.parse(readFileSync(LOCAL_PI_SETTINGS, "utf8"));
      for (const [k, v] of Object.entries(current)) {
        if (!ENGINEERING_SETTING_KEYS.includes(k)) personal[k] = v;
      }
    } catch {
      /* unreadable: treat as no personalization rather than clobbering blindly */
    }
  }
  const desired = { ...personal, ...engineering };
  const serialized = `${JSON.stringify(desired, null, 2)}\n`;
  let currentText = null;
  try {
    currentText = readFileSync(LOCAL_PI_SETTINGS, "utf8");
  } catch {
    /* missing */
  }

  const action = legacy ? "convert" : currentText === null ? "create" : currentText === serialized ? "ok" : "merge";
  if (apply && action !== "ok") {
    mkdirSync(dirname(LOCAL_PI_SETTINGS), { recursive: true });
    if (legacy) rmSync(LOCAL_PI_SETTINGS, { force: true });
    writeFileSync(LOCAL_PI_SETTINGS, serialized);
  }
  // A legacy symlink can only carry what its target holds. Once the shared file
  // was trimmed to engineering keys, converting the symlink yields a file with
  // no model/provider/theme at all - and that silently discarded one machine's
  // real choices once. Say so instead of reporting a tidy "engineering +
  // personalization".
  const personalKeys = Object.keys(personal);
  const detail = !legacy
    ? "engineering keys from adapters/pi/settings.json"
    : personalKeys.length
      ? `symlink -> real file (engineering + ${personalKeys.length} personal setting(s))`
      : "symlink -> real file; the shared file carries NO personalization, so this machine's model/provider/theme are not recovered by this conversion - set them again if they were not already lost";
  return [{ target: LOCAL_PI_SETTINGS, action, detail }];
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
