#!/usr/bin/env node
/**
 * Restore declared third-party resources by delegating to their installers:
 * skills CLI for shared skills, npm for the Pi profile runtime.
 *
 * The skills CLI has no global "install from lock" command - its
 * `experimental_install` only reads a project-level skills-lock.json - so this
 * groups the lock by source and issues one `skills add` per group.
 *
 * Plan only by default; pass --apply to install. Only skills missing from disk
 * are included unless --all is given, which keeps re-runs a no-op.
 * Exit 0 when every declared skill is covered by a group in plan mode, or when
 * every install succeeded in apply mode.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SKILLS_DIR, lockSkills, pins } from "./lib/repo.mjs";

/** Group lock entries into the source they can be re-installed from. */
export function plan({ includeInstalled = false } = {}) {
  const groups = new Map();
  const unrestorable = [];
  const covered = new Set();
  const pending = new Set();

  for (const [name, entry] of Object.entries(lockSkills())) {
    if (!includeInstalled && existsSync(join(SKILLS_DIR, name, "SKILL.md"))) continue;
    pending.add(name);
    const type = entry.sourceType;
    let source;
    if (type === "well-known") source = (entry.sourceBaseUrl ?? "").replace(/\/$/, "");
    else if (type === "github") source = entry.source;
    if (!source) { unrestorable.push({ name, type, reason: type === "well-known" ? "no sourceBaseUrl" : `unsupported sourceType "${type}"` }); continue; }
    const key = `${type}\u0000${source}`;
    if (!groups.has(key)) groups.set(key, { type, source, skills: [] });
    groups.get(key).skills.push(name);
    covered.add(name);
  }

  // Coverage is judged over the set we intend to restore, not over the whole
  // lock: skills skipped because they are already on disk are not "missing".
  const missing = [...pending].filter((n) => !covered.has(n));
  const groupsOut = [...groups.values()].map((g) => ({ ...g, skills: g.skills.sort() }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.source.localeCompare(b.source));
  return { groups: groupsOut, unrestorable, pending: [...pending].sort(), pendingOnDisk: groupsOut.reduce((n, g) => n + g.skills.length, 0), missing };
}

export function commands(group, { version } = {}) {
  const cli = `npx --yes skills@${version ?? pins().skillsCli}`;
  return `${cli} add ${group.source} -g -s ${group.skills.join(" ")} -a zed -y`;
}

function npmPackageState(name, expected) {
  const npm = spawnSync("npm", ["root", "--global"], { encoding: "utf8" });
  if (npm.status !== 0) return { name, expected, installed: null, restorable: false, detail: "npm is unavailable" };
  const packageJson = join(npm.stdout.trim(), name, "package.json");
  let installed = null;
  try { installed = JSON.parse(readFileSync(packageJson, "utf8")).version ?? null; } catch { /* missing */ }
  return { name, expected, installed, restorable: true, detail: installed === expected ? "already installed" : installed ? `upgrade ${installed} -> ${expected}` : "not installed" };
}

export function run({ apply = false, all = false, json = false } = {}) {
  const p = plan({ includeInstalled: all });
  const declaredPins = pins();
  const cliVersion = declaredPins.skillsCli;
  const adapter = npmPackageState("pi-profile-switch", declaredPins.piProfileSwitch);
  const coverageOk = p.unrestorable.length === 0 && p.missing.length === 0 && adapter.restorable;

  // Batched runs do fail transiently (upstream rate limits, flaky network), so a
  // failed group is retried before it is reported. Observed in the clean-HOME
  // drill: 4 of 14 groups failed once and every one of them succeeded on retry.
  const attempts = Number(process.env.RESTORE_ATTEMPTS ?? 2);
  const results = [];
  if (apply) {
    for (const group of p.groups) {
      // `-a zed` is load-bearing, not cosmetic: Zed is the "universal" target
      // that makes the skills CLI install into ~/.agents/skills/ instead of a
      // single harness's private directory. Without it the skills land in a
      // per-client path and pi/Codex never see them.
      const argv = ["--yes", `skills@${cliVersion}`, "add", group.source, "-g", "-s", ...group.skills, "-a", "zed", "-y"];
      let r;
      let used = 0;
      while (used < attempts) {
        used += 1;
        r = spawnSync("npx", argv, { encoding: "utf8", timeout: 900_000 });
        if (r.status === 0) break;
        if (used < attempts) spawnSync("sleep", ["3"]);
      }
      const detail = r.status === 0 ? "" : (r.stderr ?? "").split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 140) ?? `exit ${r.status}`;
      results.push({ source: group.source, skills: group.skills.length, ok: r.status === 0, attempts: used, detail });
      if (!json) process.stdout.write(`${r.status === 0 ? "ok  " : "FAIL"}  ${group.source}  (${group.skills.length} skills)${used > 1 ? `  [retry ${used - 1}]` : ""}\n`);
    }
  }

  let adapterResult = { ...adapter, ok: adapter.installed === adapter.expected };
  if (apply && !adapterResult.ok && adapter.restorable) {
    const spec = `${adapter.name}@${adapter.expected}`;
    const r = spawnSync("npm", ["install", "--global", "--ignore-scripts", spec], { encoding: "utf8", timeout: 900_000 });
    adapterResult = { ...adapter, ok: r.status === 0, detail: r.status === 0 ? "installed" : (r.stderr ?? "").trim().split("\n").slice(-1)[0] ?? `exit ${r.status}` };
    if (!json) console.log(`${adapterResult.ok ? "ok  " : "FAIL"}  npm:${spec}${adapterResult.detail ? `  (${adapterResult.detail})` : ""}`);
  }

  const ok = coverageOk && results.every((r) => r.ok) && (apply ? adapterResult.ok : adapter.restorable);
  if (json) {
    console.log(JSON.stringify({ ok, apply, cliVersion, coverageOk, ...p, results, adapter: adapterResult }, null, 2));
  } else {
    if (!apply) {
      for (const group of p.groups) console.log(commands(group, { version: cliVersion }));
      if (!p.groups.length) console.log(`nothing to restore (${all ? "lock is empty" : "every declared skill is already on disk"})`);
      if (adapter.installed !== adapter.expected) console.log(`npm install --global --ignore-scripts ${adapter.name}@${adapter.expected}`);
      else console.log(`${adapter.name}@${adapter.expected} already installed`);
    }
    for (const u of p.unrestorable) console.log(`  ! cannot restore ${u.name}: ${u.reason}`);
    for (const n of p.missing) console.log(`  ! declared but not grouped: ${n}`);
    console.log(`restore: ${ok ? "OK" : "FAILED"} (${p.pendingOnDisk} skills across ${p.groups.length} source groups; ${adapter.name}@${adapter.expected})${apply ? "" : "  [plan only - add --apply to install]"}`);
  }
  return ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(run({ apply: process.argv.includes("--apply"), all: process.argv.includes("--all"), json: process.argv.includes("--json") }));
}
