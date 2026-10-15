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
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { atomicWrite } from "./lib/atomic-write.mjs";
import { pathToFileURL } from "node:url";
import { assertConfigurationWrite } from "./lib/configuration-write-guard.mjs";
import { ENGINEERING_SETTING_KEYS, HOME, LOCAL_PI_SETTINGS, REPO, engineeringPiSettings, managedLinks, pins, projectionSource, isSymlink, relTarget, staleManagedLinks } from "./lib/repo.mjs";

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
  for (const target of staleManagedLinks()) {
    actions.push({ source: "(removed generated profile)", target, action: "remove", detail: "dangling symlink to a removed repo profile" });
    if (apply) { assertConfigurationWrite(target, HOME); rmSync(target, { force: true }); }
  }
  for (const [src, target] of managedLinks()) {
    const source = projectionSource(src);
    const record = (action, detail) => actions.push({ source: src, target, action, detail });

    if (!existsSync(source)) { record("skip", "source missing in repo"); continue; }
    if (apply) assertConfigurationWrite(target, HOME);
    mkdirSync(dirname(target), { recursive: true });
    let realDir = dirname(target);
    try { realDir = realpathSync(dirname(target)); } catch { /* keep literal */ }
    const want = relTarget(realDir, source);

    if (!existsSync(target) && !isSymlink(target)) {
      record("create", want);
      if (apply) replaceProjection(target, want);
      continue;
    }
    if (lstatSync(target).isSymbolicLink()) {
      const current = readlinkSync(target);
      if (current === want) { record("ok", current); continue; }
      record("fix", `${current} -> ${want}`);
      if (apply) replaceProjection(target, want);
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
  // engineering keys (packages and adapter resource exclusions); the machine keeps its own model/provider/theme
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
      const mark = { ok: "ok  ", create: apply ? "made" : "todo", fix: apply ? "fixed" : "todo", remove: apply ? "gone" : "todo", skip: "SKIP", conflict: "FAIL" }[a.action];
      console.log(`${mark}  ${a.target}  ${a.action === "ok" ? "" : `(${a.detail})`}`);
    }
    for (const a of settingsActions) {
      const mark = { ok: "ok  ", create: apply ? "made" : "todo", convert: apply ? "conv" : "todo", merge: apply ? "mrge" : "todo" }[a.action];
      console.log(`${mark}  ${a.target}  ${a.action === "ok" ? "" : `(${a.detail})`}`);
    }
    console.log(`projections: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}${apply ? "" : "  [dry run]"}`);
    if (!ok && !apply) console.log(`re-run with --apply to write the ${(counts.create ?? 0) + (counts.fix ?? 0) + (counts.remove ?? 0)} pending projection change(s)`);
    if (!ok && apply) console.log("bootstrap: FAILED - resolve the conflicts/skips above");
    else console.log(ok ? "bootstrap: OK" : "bootstrap: pending");
  }
  return ok ? 0 : 1;
}

/** Compare settings values without treating formatting or top-level key order as drift. */
export function settingsMatch(currentText, desired) {
  try {
    const current = JSON.parse(currentText);
    return current !== null && typeof current === "object" && !Array.isArray(current)
      && Object.keys(current).length === Object.keys(desired).length
      && Object.keys(desired).every((key) => JSON.stringify(current[key]) === JSON.stringify(desired[key]));
  } catch { return false; }
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
  const expectedHash = process.env.HARNESS_EXPECTED_PI_SETTINGS_HASH;

  const legacy = existsSync(LOCAL_PI_SETTINGS) && lstatSync(LOCAL_PI_SETTINGS).isSymbolicLink();
  let personal = {};
  const currentText = readFileSyncOrMissing(LOCAL_PI_SETTINGS);
  if (currentText !== null) {
    try {
      const current = JSON.parse(currentText);
      if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error("Invalid native settings object");
      personal = Object.fromEntries(Object.entries(current).filter(([key]) => !Object.hasOwn(engineering, key)));
    } catch {
      throw new Error("Native Pi settings are unreadable or invalid; personalization was not replaced.");
    }
  }
  const desired = { ...personal, ...engineering };
  const serialized = `${JSON.stringify(desired, null, 2)}\n`;
  if (expectedHash && createHash("sha256").update(currentText ?? "null").digest("hex") !== expectedHash) {
    throw Object.assign(new Error("Native Pi settings changed during synchronization; stopped without replacing them."), { code: "ECHANGED" });
  }
  const action = legacy ? "convert" : currentText === null ? "create" : settingsMatch(currentText, desired) ? "ok" : "merge";
  if (apply && action !== "ok") {
    assertConfigurationWrite(LOCAL_PI_SETTINGS, HOME);
    mkdirSync(dirname(LOCAL_PI_SETTINGS), { recursive: true });
    if (readFileSyncOrMissing(LOCAL_PI_SETTINGS) !== currentText) throw new Error("Native Pi settings changed before writing.");
    if (legacy) rmSync(LOCAL_PI_SETTINGS, { force: true });
    if (currentText === null || legacy) writeFileSync(LOCAL_PI_SETTINGS, serialized, { flag: "wx", mode: 0o600 });
    else atomicWrite(LOCAL_PI_SETTINGS, serialized, `${process.pid}-settings`, currentText, () => assertConfigurationWrite(LOCAL_PI_SETTINGS, HOME));
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

function replaceProjection(target, want) {
  assertConfigurationWrite(target, HOME);
  const temporary = `${target}.harness-${process.pid}.tmp`;
  let created = false;
  try {
    symlinkSync(want, temporary); created = true;
    assertConfigurationWrite(target, HOME);
    renameSync(temporary, target);
  } finally { if (created) rmSync(temporary, { force: true }); }
}

function readFileSyncOrMissing(path) {
  try { return readFileSync(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
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
