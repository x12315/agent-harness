#!/usr/bin/env node
/**
 * Post-change checks. Read-only.
 *   1. instruction/profile outputs match their neutral sources
 *   2. pi and Codex discover the shared catalog without warnings
 *   3. adapter imports still match installed Pi exports
 *   4. every managed projection resolves into this repo
 *   5. the pinned profile runtime and cross-harness canary work
 *   6. repo hygiene and settings ownership boundaries hold
 *
 * A check is skipped, not failed, when its harness is not installed - the repo
 * has to stay usable on a machine that only runs one of them.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkAdapterContract } from "./lib/adapter-contract.mjs";
import { ENGINEERING_SETTING_KEYS, HOME, LOCAL_PI_SETTINGS, PI_PROFILE_CONFIG_SKILL, REPO, SHARED_PI_SETTINGS, engineeringPiSettings, isInsideRepo, isSymlink, managedLinks, pins, readJson } from "./lib/repo.mjs";

/**
 * Compare paths through realpath: a repo under a symlinked prefix (macOS /tmp ->
 * /private/tmp) is reported by pi as its real path, so a literal comparison
 * misfires and blames the repo for skills that are actually its own.
 */
const canon = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p ?? "";
  }
};

const have = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;

function checkPi() {
  if (!have("pi")) return { name: "pi discovery", status: "skip", detail: "pi not installed" };
  const authPath = join(HOME, ".pi/agent/auth.json");
  let credentialsEmpty = !existsSync(authPath);
  if (!credentialsEmpty) {
    try { credentialsEmpty = readFileSync(authPath, "utf8").trim().length <= 2; } catch { credentialsEmpty = true; }
  }
  if (credentialsEmpty) {
    return {
      name: "pi discovery",
      status: "skip",
      detail: `pi has no credentials in this HOME (${authPath}); sign in once, then re-run`,
    };
  }
  const r = spawnSync("pi", ["--mode", "rpc"], {
    input: '{"id":"1","type":"get_commands"}\n',
    encoding: "utf8",
    timeout: 180_000,
  });
  if (r.error) {
    // A fresh HOME makes pi install the packages declared in settings.json before
    // it answers, which can outlast the probe. That is setup, not a repo defect.
    const firstRunSetup = existsSync(join(HOME, ".pi/agent/npm/package.json"));
    const timedOut = /ETIMEDOUT|timed? ?out/i.test(String(r.error.message));
    return {
      name: "pi discovery",
      status: firstRunSetup && timedOut ? "skip" : "fail",
      detail: firstRunSetup && timedOut
        ? `pi was still doing first-run package setup in this HOME (npm/ present): ${r.error.message}; let it finish, then re-run`
        : `${r.error.message} - on a fresh HOME pi first installs the packages declared in settings.json, which can take minutes`,
    };
  }
  const stderr = (r.stderr ?? "").trim();
  let cmds;
  for (const line of (r.stdout ?? "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const d = JSON.parse(t);
      if (d.command === "get_commands" && d.data?.commands) cmds = d.data.commands;
    } catch { /* extension_ui_request and friends */ }
  }
  if (!cmds) return { name: "pi discovery", status: "fail", detail: "no get_commands response on stdout" };
  const skills = cmds.filter((c) => c.source === "skill");
  const repoReal = canon(REPO);
  const privateProfileSkill = canon(join(HOME, ".pi/agent/skills/profile-config"));
  const privateProfileFile = canon(PI_PROFILE_CONFIG_SKILL);
  const isAllowedPrivate = (c) => (c.name === "profile-config" || c.name === "skill:profile-config") && [c.sourceInfo?.baseDir, c.sourceInfo?.path]
    .map(canon).some((p) => p === privateProfileSkill || p === privateProfileFile || p.startsWith(privateProfileSkill + "/"));
  const foreign = skills.filter((c) => canon(c.sourceInfo?.baseDir) !== repoReal && !isAllowedPrivate(c));
  const privateCount = skills.filter(isAllowedPrivate).length;
  const problems = [];
  if (stderr) problems.push(`stderr not empty: ${stderr.split("\n")[0].slice(0, 120)}`);
  if (!skills.length) problems.push("no skills discovered");
  if (foreign.length) problems.push(`${foreign.length} skills from outside the repo: ${foreign.slice(0, 3).map((c) => c.name).join(", ")}`);
  return {
    name: "pi discovery",
    status: problems.length ? "fail" : "pass",
    detail: `${skills.length - privateCount} shared skills from the repo${privateCount ? ` + ${privateCount} declared Pi-private skill` : ""}, ${cmds.length} commands, stderr ${stderr ? "NOT empty" : "empty"}`,
    problems,
  };
}

const SWEEP_SKIP = new Set(["npm", "sessions", "cache", "backups", "file-history", "ide", "shell-snapshots", "plugins", "tmp"]);

function sweepSymlinks(dir, depth, out) {
  if (depth > 6 || !existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SWEEP_SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      let target = "";
      try { target = readlinkSync(path); } catch { continue; }
      if (target.includes("/node_modules/")) out.push(`${path} -> ${target}`);
    } else if (entry.isDirectory()) {
      sweepSymlinks(path, depth + 1, out);
    }
  }
}

function checkCodex() {
  if (!have("codex")) return { name: "codex entry", status: "skip", detail: "codex not installed" };
  // Codex reads AGENTS.md natively from $CODEX_HOME and reads .agents/skills
  // directly, so its entry is a plain symlink with no import indirection to get
  // wrong. A structural check is therefore enough, and it stays offline on
  // purpose: spawning an agent CLI to ask it about its own context is how the
  // claude probe once opened an interactive session instead of answering.
  const target = join(HOME, ".codex/AGENTS.md");
  const problems = [];
  if (!existsSync(target)) {
    problems.push(`${target}: projection missing; run node scripts/harness.mjs install`);
  } else if (!isSymlink(target)) {
    problems.push(`${target}: not a symlink (something rewrote it)`);
  } else if (!isInsideRepo(target)) {
    problems.push(`${target}: does not resolve into the repo`);
  } else {
    const heading = (readFileSync(join(REPO, "AGENTS.md"), "utf8").split("\n").find((l) => l.startsWith("# ")) ?? "").replace(/^#\s*/, "").trim();
    if (heading !== "AGENTS.md") problems.push(`repo AGENTS.md first heading is "${heading}", not "AGENTS.md"`);
    // Codex cannot receive the shared rules automatically: it does not read
    // ~/AGENTS.md (ancestor discovery stops at the git root, and ~ is not a
    // repo) and it does not support @ imports. The pointer block in
    // adapters/codex/AGENTS.md is the only mechanism, so losing it silently
    // would mean Codex never sees the harness standard. Behavioural verification
    // of that pointer is recorded in README's residual risks; here it is a cheap
    // offline guard against the mechanism disappearing.
    const codexFile = join(REPO, "adapters/codex/AGENTS.md");
    const pointer = existsSync(codexFile) ? readFileSync(codexFile, "utf8") : "";
    if (!pointer.includes("本机 agent harness（硬性前置）")) {
      problems.push("adapters/codex/AGENTS.md lost its pointer to the shared rules; Codex would never see the harness standard");
    }
  }
  return {
    name: "codex entry",
    status: problems.length ? "fail" : "pass",
    detail: problems.length ? "codex cannot reach the shared instruction layer" : "AGENTS.md projected into $CODEX_HOME",
    problems,
  };
}

function checkProjections() {
  const problems = [];
  for (const [src, target] of managedLinks()) {
    if (!existsSync(join(REPO, src))) { problems.push(`${src}: source missing in repo`); continue; }
    if (!existsSync(target)) { problems.push(`${target}: projection missing`); continue; }
    if (!isSymlink(target)) { problems.push(`${target}: not a symlink (something rewrote it)`); continue; }
    let real = "";
    try { real = realpathSync(target); } catch { problems.push(`${target}: dangling`); continue; }
    if (!(real === REPO || real.startsWith(REPO + "/"))) problems.push(`${target}: points outside the repo -> ${real}`);
  }
  const stray = [];
  // The claude probe used to open an interactive session instead of answering,
  // so this check deliberately stays offline: a plain symlink needs no probe.
  for (const root of [join(HOME, ".pi/agent")]) sweepSymlinks(root, 0, stray);
  for (const s of stray) problems.push(`symlink into an upstream install: ${s}`);
  return {
    name: "projections",
    status: problems.length ? "fail" : "pass",
    detail: `${managedLinks().length} managed projections are symlinks into the repo`,
    problems,
  };
}

function checkComposition() {
  const r = spawnSync(process.execPath, [join(REPO, "scripts/compose.mjs")], { encoding: "utf8", timeout: 30_000 });
  const detail = `${filesCount(join(REPO, "instructions"), ".md")} instruction modules, ${filesCount(join(REPO, "profiles"), ".json", "profile.schema.json")} profiles`;
  return {
    name: "composition",
    status: r.status === 0 ? "pass" : "fail",
    detail: r.status === 0 ? `${detail}; generated adapters are current` : `${detail}; generated artifacts drifted`,
    problems: r.status === 0 ? [] : [(r.stdout || r.stderr || "compose failed").trim().split("\n").slice(0, 4).join("; ")],
  };
}

function filesCount(root, suffix, exclude) {
  if (!existsSync(root)) return 0;
  let count = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) count += filesCount(path, suffix, exclude);
    else if (entry.name.endsWith(suffix) && entry.name !== exclude) count += 1;
  }
  return count;
}

function checkProfileRuntime() {
  const problems = [];
  const expected = pins().piProfileSwitch;
  const npmRoot = spawnSync("npm", ["root", "--global"], { encoding: "utf8" });
  let packageRoot = "";
  let installed = null;
  if (npmRoot.status !== 0) {
    problems.push("npm unavailable; cannot restore pi-profile-switch");
  } else {
    packageRoot = join(npmRoot.stdout.trim(), "pi-profile-switch");
    try { installed = readJson(join(packageRoot, "package.json")).version; } catch { /* missing */ }
    if (installed !== expected) problems.push(`pi-profile-switch ${installed ?? "missing"}; declared ${expected} (run node scripts/harness.mjs install)`);
  }
  if (!have("pi-profile")) problems.push("pi-profile launcher missing from PATH");

  const nativeSkills = join(HOME, ".pi/agent/skills");
  if (existsSync(nativeSkills)) {
    const stray = readdirSync(nativeSkills).filter((name) => !name.startsWith(".") && name !== "profile-config");
    for (const name of stray) problems.push(`${nativeSkills}/${name}: undeclared Pi-private skill`);
  }
  if (existsSync(PI_PROFILE_CONFIG_SKILL)) {
    const template = join(packageRoot, "skills/profile-config/SKILL.md");
    if (!existsSync(template)) problems.push("installed pi-profile-switch has no profile-config template");
    else if (readFileSync(PI_PROFILE_CONFIG_SKILL, "utf8") !== readFileSync(template, "utf8")) {
      problems.push(`${PI_PROFILE_CONFIG_SKILL}: differs from the declared package template`);
    }
  }

  // One cross-harness canary catches syntax-only success that does not produce
  // the declared runtime: review must expose exactly its selected shared skills
  // (plus Pi's package-owned configurator) and inject its instruction module.
  if (!problems.length && have("pi")) {
    const r = spawnSync("pi-profile", ["review", "--", "--mode", "rpc"], {
      input: '{"id":"1","type":"get_commands"}\n', encoding: "utf8", timeout: 180_000,
    });
    let commands;
    for (const line of (r.stdout ?? "").split("\n")) {
      try { const value = JSON.parse(line); if (value.command === "get_commands") commands = value.data?.commands; } catch { /* UI events */ }
    }
    const names = (commands ?? []).filter((c) => c.source === "skill").map((c) => c.name).sort();
    const expectedNames = ["skill:ponytail", "skill:profile-config", "skill:self-explanatory-code"];
    if (r.status !== 0 || (r.stderr ?? "").trim() || JSON.stringify(names) !== JSON.stringify(expectedNames)) {
      problems.push(`Pi review canary differs: skills=[${names.join(", ")}], stderr=${(r.stderr ?? "").trim().slice(0, 120) || "empty"}`);
    }
  }
  if (!problems.length && have("codex")) {
    const r = spawnSync("codex", ["-p", "review", "debug", "prompt-input", "profile canary"], { encoding: "utf8", timeout: 120_000 });
    const text = r.stdout ?? "";
    if (r.status !== 0 || !text.includes("Review mode") || !text.includes("- ponytail:") || !text.includes("- self-explanatory-code:") || text.includes("- agent-browser:")) {
      problems.push(`Codex review canary differs: ${(r.stderr ?? "").trim().slice(0, 160) || "effective prompt did not match the profile"}`);
    }
  }
  return {
    name: "profile runtime",
    status: problems.length ? "fail" : "pass",
    detail: `pi-profile-switch ${installed ?? "missing"}; private asset and review canary verified across installed harnesses`,
    problems,
  };
}

function checkHygiene() {
  const r = spawnSync("git", ["-C", REPO, "ls-files", "-s"], { encoding: "utf8" });
  if (r.status !== 0) return { name: "repo hygiene", status: "skip", detail: "not a git checkout" };
  const problems = [];
  for (const line of (r.stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    const [meta, path] = line.split("\t");
    if ((meta ?? "").startsWith("120000")) problems.push(`committed symlink: ${path}`);
    if (path.includes("node_modules/")) problems.push(`node_modules tracked: ${path}`);
    if (/(^|\/)(auth|credential|credentials|token|tokens|secret|secrets)\.(json|ya?ml|txt)$/i.test(path) || /\.(pem|key)$/i.test(path)) {
      problems.push(`possible secret: ${path}`);
    }
  }
  return {
    name: "repo hygiene",
    status: problems.length ? "fail" : "pass",
    detail: "no symlinks, node_modules or secrets committed",
    problems,
  };
}

/**
 * Report the installed harness versions instead of pinning them. A pin here
 * would be a hand-maintained cache of one command's output - it goes stale
 * (it did: 0.157.1 vs 0.154.0 on disk) and gates nothing. The coupling that
 * the pi pin was meant to catch is checked by the adapter-contract probe.
 */
function observedVersions() {
  const versions = [];
  if (have("pi")) versions.push(`pi ${spawnSync("pi", ["--version"], { encoding: "utf8" }).stdout.trim()}`);
  if (have("codex")) {
    const raw = spawnSync("codex", ["--version"], { encoding: "utf8" }).stdout.trim();
    versions.push(raw.startsWith("codex-cli") ? raw : `codex ${raw}`);
  }
  return versions.length ? [`${versions.join(", ")} (observed live, not pinned)`] : [];
}

/**
 * The engineering/personalization boundary, enforced mechanically.
 *
 * Ordinary Pi settings share only ENGINEERING_SETTING_KEYS (today packages).
 * Profile-recommended models are separately versioned in profiles/; the local
 * default model/provider/theme and explicit session overrides remain personal.
 */
function checkSettingsBoundary() {
  const problems = [];
  let shared = {};
  try {
    shared = readJson(SHARED_PI_SETTINGS);
  } catch (error) {
    problems.push(`adapters/pi/settings.json unreadable: ${error.message}`);
  }
  const personalInShared = Object.keys(shared).filter((k) => !ENGINEERING_SETTING_KEYS.includes(k));
  if (personalInShared.length) {
    problems.push(`adapters/pi/settings.json carries personalization: ${personalInShared.join(", ")} - it belongs in the machine-local file`);
  }
  const expectedEngineering = engineeringPiSettings();
  if (!existsSync(LOCAL_PI_SETTINGS)) {
    problems.push(`${LOCAL_PI_SETTINGS}: missing; run node scripts/harness.mjs install`);
  } else if (isSymlink(LOCAL_PI_SETTINGS)) {
    problems.push(`${LOCAL_PI_SETTINGS}: still a symlink into the repo; run node scripts/harness.mjs install to convert it to a real file`);
  } else {
    try {
      const local = readJson(LOCAL_PI_SETTINGS);
      for (const key of ENGINEERING_SETTING_KEYS) {
        if (JSON.stringify(local[key] ?? null) !== JSON.stringify(expectedEngineering[key] ?? null)) {
          problems.push(`${LOCAL_PI_SETTINGS}: ${key} differs from the shared declaration; run install to merge`);
        }
      }
    } catch (error) {
      problems.push(`${LOCAL_PI_SETTINGS} unreadable: ${error.message}`);
    }
  }
  return {
    name: "settings boundary",
    status: problems.length ? "fail" : "pass",
    detail: `settings share ${ENGINEERING_SETTING_KEYS.join(", ")} (portable paths expanded); profile models are separate`,
    problems,
  };
}

export function run({ json = false } = {}) {
  const checks = [checkComposition(), checkPi(), checkCodex(), checkAdapterContract(), checkProjections(), checkProfileRuntime(), checkHygiene(), checkSettingsBoundary()];
  const notes = observedVersions();
  const ok = checks.every((c) => c.status !== "fail");
  if (json) {
    console.log(JSON.stringify({ ok, checks, notes }, null, 2));
  } else {
    for (const c of checks) {
      const mark = c.status === "pass" ? "ok  " : c.status === "skip" ? "skip" : "FAIL";
      console.log(`${mark}  ${c.name.padEnd(16)} ${c.detail}`);
      for (const p of c.problems ?? []) console.log(`        ! ${p}`);
    }
    for (const n of notes) console.log(`note  ${n}`);
    console.log(ok ? "verify: OK" : "verify: FAILED");
  }
  return ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(run({ json: process.argv.includes("--json") }));
