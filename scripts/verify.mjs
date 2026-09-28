#!/usr/bin/env node
/**
 * Post-change checks. Read-only.
 *   1. pi discovers every skill from this repo and reports no warnings
 *   2. the Claude Code entry still reaches AGENTS.md
 *   3. every managed projection is a symlink pointing into this repo
 *   4. repo hygiene: no committed symlinks, node_modules or secrets
 *
 * A check is skipped, not failed, when its harness is not installed - the repo
 * has to stay usable on a machine that only runs one of them.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HOME, REPO, isSymlink, managedLinks, pins } from "./lib/repo.mjs";

const CLAUDE_PROBE =
  "只回答你在全局指令层文件里看到的第一行标题文本（去掉开头的 # 号与空格）。若你的上下文里没有注入这样的指令文件，只回答 NO。";

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
  const foreign = skills.filter((c) => canon(c.sourceInfo?.baseDir) !== repoReal);
  const problems = [];
  if (stderr) problems.push(`stderr not empty: ${stderr.split("\n")[0].slice(0, 120)}`);
  if (!skills.length) problems.push("no skills discovered");
  if (foreign.length) problems.push(`${foreign.length} skills from outside the repo: ${foreign.slice(0, 3).map((c) => c.name).join(", ")}`);
  return {
    name: "pi discovery",
    status: problems.length ? "fail" : "pass",
    detail: `${skills.length} skills from the repo, ${cmds.length} commands, stderr ${stderr ? "NOT empty" : "empty"}`,
    problems,
  };
}

function checkClaude() {
  if (!have("claude")) return { name: "claude entry", status: "skip", detail: "claude not installed" };
  const r = spawnSync("claude", ["-p", CLAUDE_PROBE], { encoding: "utf8", timeout: 300_000 });
  if (r.error) return { name: "claude entry", status: "fail", detail: String(r.error.message) };
  const out = (r.stdout ?? "").trim();
  if (/not logged in|please run \/login|invalid api key|unauthorized/i.test(out)) {
    return { name: "claude entry", status: "skip", detail: "claude is not signed in for this HOME; sign in once, then re-run" };
  }
  const ok = out.includes("AGENTS.md");
  return {
    name: "claude entry",
    status: ok ? "pass" : "fail",
    detail: ok ? "entry reaches AGENTS.md" : `expected AGENTS.md, got: ${out.slice(0, 80) || "(empty)"}`,
    problems: ok ? undefined : ["adapters/claude-code/CLAUDE.md: check the @ path - imports resolve against the file's REAL path"],
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
  for (const root of [join(HOME, ".pi/agent"), join(HOME, ".claude")]) sweepSymlinks(root, 0, stray);
  for (const s of stray) problems.push(`symlink into an upstream install: ${s}`);
  return {
    name: "projections",
    status: problems.length ? "fail" : "pass",
    detail: `${managedLinks().length} managed projections are symlinks into the repo`,
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

function versionNotes() {
  const p = pins();
  const notes = [];
  const piVersion = have("pi") ? spawnSync("pi", ["--version"], { encoding: "utf8" }).stdout.trim() : "";
  if (piVersion && p.piVerifiedWith && piVersion !== p.piVerifiedWith) {
    notes.push(`pi ${piVersion} != verified-with ${p.piVerifiedWith} (extensions depend on its exports; re-run the checks)`);
  }
  return notes;
}

export function run({ json = false } = {}) {
  const checks = [checkPi(), checkClaude(), checkProjections(), checkHygiene()];
  const notes = versionNotes();
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
