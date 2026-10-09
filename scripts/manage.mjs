#!/usr/bin/env node
/** Human-facing management operations for the harness catalog. */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { compose, inspect } from "./compose.mjs";
import { ENGINE, HOME, REPO, classify, isInsideRepo, isSymlink, managedLinks, pins, projectionSource } from "./lib/repo.mjs";

const have = (command) => spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).status === 0;

function installedGlobalPackageVersion(name) {
  const root = spawnSync("npm", ["root", "--global"], { encoding: "utf8" });
  if (root.status !== 0) return null;
  try { return JSON.parse(readFileSync(join(root.stdout.trim(), name, "package.json"), "utf8")).version ?? null; }
  catch { return null; }
}

function gitState(root = REPO) {
  const head = spawnSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" });
  const status = spawnSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
  return {
    head: head.status === 0 ? head.stdout.trim() : "not-a-git-checkout",
    clean: status.status === 0 && !status.stdout.trim(),
  };
}

function activePiProfile() {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) return null;
  try {
    const state = JSON.parse(readFileSync(join(agentDir, "pi-profile.json"), "utf8"));
    return typeof state.profile === "string" ? state.profile : null;
  } catch {
    return null;
  }
}

export function statusReport() {
  const catalog = compose();
  const skills = classify();
  const compositionCurrent = [...catalog.outputs].every(([path, content]) => existsSync(path) && readFileSync(path, "utf8") === content);
  const links = managedLinks();
  const projected = links.filter(([source, target]) => existsSync(target) && isSymlink(target) && existsSync(projectionSource(source)) && realpathSync(target) === realpathSync(projectionSource(source))).length;
  const declaredPins = pins();
  const installedProfileSwitch = installedGlobalPackageVersion("pi-profile-switch");
  const profiles = [...catalog.profiles.values()].sort((a, b) => a.name.localeCompare(b.name)).map((profile) => ({
    name: profile.name,
    label: profile.label,
    description: profile.description,
    sharedSkills: profile.skills,
    piModel: profile.adapters.pi.model
      ? `${profile.adapters.pi.model.provider}/${profile.adapters.pi.model.id}`
      : "inherit",
    codexModel: profile.adapters.codex.model?.id ?? "inherit",
  }));
  return {
    ok: compositionCurrent && projected === links.length && skills.declaredNotInstalled.length === 0 && skills.installedNotDeclared.length === 0 && installedProfileSwitch === declaredPins.piProfileSwitch,
    repo: REPO,
    catalog: REPO,
    engine: ENGINE,
    interfaceVersion: 1,
    engineGit: gitState(ENGINE),
    git: gitState(),
    activePiProfile: activePiProfile(),
    profiles,
    skills: {
      declared: skills.declared.size,
      own: skills.own.size,
      installed: skills.disk.size,
      missing: skills.declaredNotInstalled,
      unregistered: skills.installedNotDeclared,
    },
    composition: { current: compositionCurrent },
    projections: { healthy: projected, total: links.length },
    runtimes: {
      pi: have("pi"),
      codex: have("codex"),
      piProfile: have("pi-profile"),
      piProfileSwitch: installedProfileSwitch,
      piProfileSwitchDeclared: declaredPins.piProfileSwitch,
    },
  };
}

export function showStatus({ json = false } = {}) {
  let report;
  try { report = statusReport(); }
  catch (error) {
    if (json) console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    else console.error(`harness status: FAILED - ${error.message}`);
    return 1;
  }
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  console.log("Harness Control Plane / Harness 管理面");
  console.log(`  仓库       ${report.repo} @ ${report.git.head} (${report.git.clean ? "clean" : "dirty"})`);
  console.log(`  生成物     ${report.composition.current ? "current" : "DRIFT"}`);
  console.log(`  投影       ${report.projections.healthy}/${report.projections.total}`);
  console.log(`  Skills     ${report.skills.installed} installed = ${report.skills.declared} declared + ${report.skills.own} own`);
  const profileRuntime = report.runtimes.piProfile && report.runtimes.piProfileSwitch
    ? `${report.runtimes.piProfileSwitch}${report.runtimes.piProfileSwitch === report.runtimes.piProfileSwitchDeclared ? "" : ` (declared ${report.runtimes.piProfileSwitchDeclared})`}`
    : "missing";
  console.log(`  Runtimes   pi=${report.runtimes.pi ? "ready" : "missing"} codex=${report.runtimes.codex ? "ready" : "missing"} pi-profile-switch=${profileRuntime}`);
  console.log(`  当前 Pi    ${report.activePiProfile ?? "未通过 pi-profile 运行"}`);
  console.log("\n工作 Profiles");
  for (const profile of report.profiles) {
    console.log(`  ${profile.name.padEnd(10)} ${profile.description}`);
    console.log(`             Pi ${profile.piModel} · Codex ${profile.codexModel}`);
  }
  if (report.skills.missing.length) console.log(`\n  missing skills: ${report.skills.missing.join(", ")}`);
  if (report.skills.unregistered.length) console.log(`\n  unregistered skills: ${report.skills.unregistered.join(", ")}`);
  console.log("\n常用操作");
  console.log("  harness profile list|show <name>|edit <name>");
  console.log("  harness run <pi|codex> <profile>");
  console.log("  harness apply    # compose, project, and verify");
  console.log("  harness doctor   # read-only full verification");
  return report.ok ? 0 : 1;
}

export function profilePath(name) {
  const state = compose();
  const profile = state.profiles.get(name);
  if (!profile) throw new Error(`unknown profile: ${name}`);
  return profile.path;
}

export function editProfile(name) {
  let path;
  try { path = profilePath(name); }
  catch (error) { console.error(`profile edit: ${error.message}`); return 2; }
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  const quotedPath = `'${path.replaceAll("'", `'\\''`)}'`;
  const result = spawnSync(process.env.SHELL || "sh", ["-lc", `${editor} ${quotedPath}`], { stdio: "inherit" });
  if (result.error) {
    console.error(`profile edit: cannot start ${editor}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

export function runProfile(harness, profileName, extraArgs = []) {
  try { profilePath(profileName); }
  catch (error) { console.error(`harness run: ${error.message}`); return 2; }
  let command;
  let args;
  if (harness === "pi") {
    command = "pi-profile";
    args = [profileName, ...(extraArgs.length ? ["--", ...extraArgs] : [])];
  } else if (harness === "codex") {
    command = "codex";
    args = ["-p", profileName, ...extraArgs];
  } else {
    console.error(`harness run: expected pi or codex, got ${harness || "(missing)"}`);
    return 2;
  }
  if (!have(command)) {
    console.error(`harness run: ${command} is not installed`);
    return 1;
  }
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    console.error(`harness run: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

export function showProfiles(name, options = {}) {
  try { inspect(name, options); return 0; }
  catch (error) { console.error(`profile: ${error.message}`); return 1; }
}

export function showProfilePath(name) {
  try { console.log(profilePath(name)); return 0; }
  catch (error) { console.error(`profile path: ${error.message}`); return 2; }
}

export function help() {
  console.log(`Harness Control Plane

Usage:
  harness                              Show effective catalog status
  harness status [--json]              Show status
  harness profile list                 List profiles
  harness profile show <name>          Inspect one profile
  harness profile edit <name>          Edit source, then apply and verify
  harness profile path <name>          Print the source file path
  harness run pi <name> [pi args...]   Launch Pi through the profile runtime
  harness run codex <name> [args...]   Launch Codex with its native profile
  harness web                          Open the local composition workbench
  harness apply                        Compose, project, and verify
  harness [--catalog=<path>] doctor [--serial]            Run the full gate (bounded parallel by default)
  harness benchmark [--runs=3] [--out=<dir>]  Measure serial/parallel full doctor
    [--baseline=<report.json>] [--max-regression-percent=20] [--max-median-ms=<ms>]
  harness verify --catalog            Check generated files and projections only
  harness verify --runtime=pi --profile=<id>  Check one adapter/Profile (pi or codex)
  harness install                      Restore a new machine

Low-level commands remain available:
  compose, bootstrap, restore, reconcile, drift, verify, secrets, all`);
  return 0;
}

if (basename(process.argv[1] ?? "") === "manage.mjs") showStatus({ json: process.argv.includes("--json") });
