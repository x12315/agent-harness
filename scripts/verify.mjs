#!/usr/bin/env node
/**
 * Post-change checks. Read-only.
 *   1. instruction/profile outputs match their neutral sources
 *   2. pi and Codex discover the shared catalog without warnings
 *   3. adapter imports still match installed Pi exports
 *   4. every managed projection resolves into this repo
 *   5. the human control plane bypasses the model under a read-only Profile
 *   6. the pinned profile runtime and cross-harness canary work
 *   7. repo hygiene and settings ownership boundaries hold
 *
 * A check is skipped, not failed, when its harness is not installed - the repo
 * has to stay usable on a machine that only runs one of them.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compose } from "./compose.mjs";
import { checkAdapterContract } from "./lib/adapter-contract.mjs";
import { ENGINEERING_SETTING_KEYS, HOME, LOCAL_PI_SETTINGS, PI_PROFILE_CONFIG_SKILL, REPO, SHARED_PI_SETTINGS, engineeringPiSettings, isInsideRepo, isSymlink, managedLinks, pins, readJson } from "./lib/repo.mjs";

const PI_RUNTIME_PROBE = join(REPO, "scripts/probes/pi-runtime.ts");

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
  const harnessCommands = cmds.filter((c) => c.source === "extension" && c.name === "harness");
  if (stderr) problems.push(`stderr not empty: ${stderr.split("\n")[0].slice(0, 120)}`);
  if (!skills.length) problems.push("no skills discovered");
  if (foreign.length) problems.push(`${foreign.length} skills from outside the repo: ${foreign.slice(0, 3).map((c) => c.name).join(", ")}`);
  if (harnessCommands.length !== 1) problems.push(`expected one /harness control-plane command, found ${harnessCommands.length}`);
  else if (![harnessCommands[0].sourceInfo?.path, harnessCommands[0].path].filter(Boolean).map(canon).some((p) => p.startsWith(repoReal + "/"))) {
    problems.push("/harness control-plane command does not come from the repo");
  }
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

function checkControlPlane() {
  const target = join(HOME, ".local/bin/harness");
  const problems = [];
  if (!existsSync(target)) problems.push(`${target}: missing; run node scripts/harness.mjs install`);
  else {
    const r = spawnSync(target, ["status", "--json"], { encoding: "utf8", timeout: 30_000 });
    let report;
    try { report = JSON.parse(r.stdout); } catch { /* reported below */ }
    if (r.status !== 0 || !report?.ok) problems.push((r.stderr || report?.error || "harness status failed").trim());
    else if (!Array.isArray(report.profiles) || report.profiles.length === 0) problems.push("harness status returned no profiles");
  }
  if (!problems.length && have("pi") && have("pi-profile")) {
    const canary = spawnSync(process.execPath, [join(REPO, "scripts/control-plane-canary.mjs")], { encoding: "utf8", timeout: 90_000 });
    if (canary.status !== 0) problems.push((canary.stderr || canary.stdout || "control-plane canary failed").trim());
  }
  return {
    name: "control plane",
    status: problems.length ? "fail" : "pass",
    detail: problems.length ? "human management entry is unavailable" : "harness CLI and status report are operational",
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

  // Runtime expectations come from the current declarations, not the shipped
  // presets, so user tuning remains valid while adapter drift is still caught.
  let catalog;
  if (!problems.length) {
    try { catalog = compose(); }
    catch (error) { problems.push(`cannot load profile catalog: ${error.message}`); }
  }
  if (!problems.length && have("pi")) {
    const baseRuntime = spawnSync("pi", ["--extension", PI_RUNTIME_PROBE, "--mode", "rpc", "--no-session"], {
      input: '{"id":"tools","type":"prompt","message":"/harness-runtime-probe"}\n', encoding: "utf8", timeout: 180_000,
    });
    let defaultBuiltinTools;
    for (const line of (baseRuntime.stdout ?? "").split("\n")) {
      try {
        const value = JSON.parse(line);
        if (value.type === "extension_ui_request" && value.method === "notify") {
          const notice = JSON.parse(value.message);
          if (Array.isArray(notice.activeTools) && Array.isArray(notice.builtinTools)) {
            defaultBuiltinTools = notice.activeTools.filter((name) => notice.builtinTools.includes(name)).sort();
          }
        }
      } catch { /* unrelated UI events */ }
    }
    if (baseRuntime.status !== 0 || (baseRuntime.stderr ?? "").trim() || !defaultBuiltinTools) {
      problems.push(`Pi default tool probe failed: ${(baseRuntime.stderr ?? "").trim().slice(0, 160) || "no tool response"}`);
    }
    for (const profile of !problems.length ? [...catalog.profiles.keys()].sort() : []) {
      const generated = readJson(join(REPO, `adapters/pi/profiles/${profile}.json`));
      const encodedInstruction = Buffer.from(generated.instructions ?? "", "utf8").toString("base64");
      const input = [
        '{"id":"commands","type":"get_commands"}',
        JSON.stringify({ id: "tools", type: "prompt", message: `/harness-runtime-probe ${encodedInstruction}` }),
        "",
      ].join("\n");
      const r = spawnSync("pi-profile", [profile, "--", "--extension", PI_RUNTIME_PROBE, "--mode", "rpc", "--no-session"], {
        input, encoding: "utf8", timeout: 180_000,
      });
      let commands;
      let runtimeTools;
      for (const line of (r.stdout ?? "").split("\n")) {
        try {
          const value = JSON.parse(line);
          if (value.command === "get_commands") commands = value.data?.commands;
          if (value.type === "extension_ui_request" && value.method === "notify") {
            const notice = JSON.parse(value.message);
            if (Array.isArray(notice.activeTools) && Array.isArray(notice.builtinTools)) runtimeTools = notice;
          }
        } catch { /* unrelated UI events */ }
      }
      const skillCommands = (commands ?? []).filter((c) => c.source === "skill").map((c) => c.name).sort();
      const expectedSkillCommands = [...(generated.skills ?? []).map((name) => `skill:${name}`), "skill:profile-config"].sort();
      const runtimeExtensionCommands = (commands ?? []).filter((c) => c.source === "extension");
      const missingExtensionCommands = runtimeExtensionCommands.some((c) => c.name === "harness") ? [] : ["harness"];
      const resolvedExtensions = runtimeTools?.resolvedExtensions ?? [];
      const resolvedExtensionIds = resolvedExtensions.map((extension) => extension.id).sort();
      const expectedExtensions = [...(generated.extensions ?? [])].sort();
      const allToolSources = runtimeTools?.toolSources ?? [];
      const activeToolSources = allToolSources.filter((tool) => (runtimeTools?.activeTools ?? []).includes(tool.name));
      const commandSources = runtimeExtensionCommands.map((command) => command.sourceInfo ?? {});
      const loadedRuntimeSources = [...commandSources, ...allToolSources];
      const activeRuntimeSources = [...commandSources, ...activeToolSources];
      const sourceMatchesExtension = (source, extension) => source.source === `npm:${extension.id}`
        || (source.path && extension.entry && canon(source.path) === canon(extension.entry));
      const missingLoadedExtensions = resolvedExtensions
        .filter((extension) => !loadedRuntimeSources.some((source) => sourceMatchesExtension(source, extension)))
        .map((extension) => extension.id);
      const mcpToolsAllowed = generated.mcps === undefined || generated.mcps.length > 0;
      const unexpectedRuntimeSources = activeRuntimeSources.filter((source) => source.source !== "builtin"
        && source.source !== "cli"
        && source.source !== "inline"
        && !resolvedExtensions.some((extension) => sourceMatchesExtension(source, extension))
        && !(mcpToolsAllowed && String(source.source).startsWith("mcp")));
      const expectedTools = generated.tools ?? defaultBuiltinTools;
      const activeTools = runtimeTools?.activeTools ?? [];
      const availableBuiltinTools = runtimeTools?.builtinTools ?? [];
      const actualBuiltinTools = activeTools.filter((name) => availableBuiltinTools.includes(name)).sort();
      const expectedBuiltinTools = expectedTools.filter((name) => availableBuiltinTools.includes(name)).sort();
      const missingConfiguredTools = expectedTools.filter((name) => !activeTools.includes(name));
      const activeToolAllowlistMismatch = generated.tools !== undefined
        && JSON.stringify([...activeTools].sort()) !== JSON.stringify([...generated.tools].sort());
      const unexpectedCustomTools = unexpectedRuntimeSources.map((source) => source.name ?? source.path ?? source.source);
      const expectedModel = generated.defaultProvider && generated.defaultModel
        ? { provider: generated.defaultProvider, id: generated.defaultModel }
        : undefined;
      const modelMismatch = expectedModel && JSON.stringify(runtimeTools?.model) !== JSON.stringify(expectedModel);
      const thinkingMismatch = generated.defaultThinkingLevel && runtimeTools?.thinking !== generated.defaultThinkingLevel;
      if (r.status !== 0
        || (r.stderr ?? "").trim()
        || JSON.stringify(skillCommands) !== JSON.stringify(expectedSkillCommands)
        || missingExtensionCommands.length
        || JSON.stringify(resolvedExtensionIds) !== JSON.stringify(expectedExtensions)
        || missingLoadedExtensions.length
        || JSON.stringify(actualBuiltinTools) !== JSON.stringify(expectedBuiltinTools)
        || missingConfiguredTools.length
        || activeToolAllowlistMismatch
        || unexpectedCustomTools.length
        || runtimeTools?.instructionPresent !== true
        || modelMismatch
        || thinkingMismatch) {
        problems.push(`Pi ${profile} canary differs: skills=[${skillCommands.join(", ")}], resolved extensions=[${resolvedExtensionIds.join(", ")}], unloaded extensions=[${missingLoadedExtensions.join(", ")}], active tools=[${activeTools.join(", ")}], missing commands=[${missingExtensionCommands.join(", ")}], missing configured tools=[${missingConfiguredTools.join(", ")}], allowlist=${activeToolAllowlistMismatch ? "mismatch" : "ok"}, unexpected custom tools=[${unexpectedCustomTools.join(", ")}], instruction=${runtimeTools?.instructionPresent}, model=${runtimeTools?.model ? `${runtimeTools.model.provider}/${runtimeTools.model.id}` : "missing"}, stderr=${(r.stderr ?? "").trim().slice(0, 120) || "empty"}`);
        break;
      }
    }
  }
  if (!problems.length && have("codex")) {
    const modelsResult = spawnSync("codex", ["debug", "models"], { encoding: "utf8", timeout: 120_000 });
    let codexModels = [];
    try { codexModels = JSON.parse(modelsResult.stdout ?? "{}").models ?? []; }
    catch { /* reported below */ }
    if (modelsResult.status !== 0 || (modelsResult.stderr ?? "").trim() || !codexModels.length) {
      problems.push(`Codex model catalog unavailable: ${(modelsResult.stderr ?? "").trim().slice(0, 160) || "empty model list"}`);
    }
    for (const [profile, declaration] of !problems.length ? [...catalog.profiles.entries()].sort(([a], [b]) => a.localeCompare(b)) : []) {
      const generated = readJson(join(REPO, `adapters/pi/profiles/${profile}.json`));
      const expectedSkills = generated.skills ?? [];
      const excludedSkills = catalog.skillCatalog.filter((name) => !expectedSkills.includes(name));
      const r = spawnSync("codex", ["-p", profile, "debug", "prompt-input", "profile canary"], { encoding: "utf8", timeout: 120_000 });
      let text = "";
      try {
        text = JSON.parse(r.stdout ?? "[]")
          .flatMap((message) => message.content ?? [])
          .map((content) => content.text ?? "")
          .join("\n");
      } catch { /* reported as a runtime mismatch below */ }
      const missingSkills = expectedSkills.filter((name) => !text.includes(`(file: r0/${name}/SKILL.md)`));
      const missingInstructions = declaration.instructions.filter((id) => !text.includes(catalog.modules.get(id).content));
      const leakedSkills = excludedSkills.filter((name) => text.includes(`(file: r0/${name}/SKILL.md)`));
      const sandbox = declaration.adapters.codex.sandbox;
      const approval = declaration.adapters.codex.approval;
      const expectedModel = declaration.adapters.codex.model;
      const discoveredModel = expectedModel ? codexModels.find((model) => model.slug === expectedModel.id) : undefined;
      const modelMissing = Boolean(expectedModel && !discoveredModel);
      const reasoningMissing = Boolean(expectedModel?.thinking && discoveredModel
        && !(discoveredModel.supported_reasoning_levels ?? []).some((level) => level.effort === expectedModel.thinking));
      const sandboxMissing = sandbox && !text.includes(`sandbox_mode\` is \`${sandbox}\``);
      const approvalMissing = approval === "never"
        ? !text.includes("Approval policy is currently never.")
        : approval === "on-request" && !text.includes("# Escalation Requests");
      if (r.status !== 0
        || (r.stderr ?? "").trim()
        || missingSkills.length
        || missingInstructions.length
        || leakedSkills.length
        || sandboxMissing
        || approvalMissing
        || modelMissing
        || reasoningMissing) {
        problems.push(`Codex ${profile} canary differs: missing skills=[${missingSkills.join(", ")}], leaked skills=[${leakedSkills.join(", ")}], missing instructions=[${missingInstructions.join(", ")}], sandbox=${sandboxMissing ? "missing" : "ok"}, approval=${approvalMissing ? "missing" : "ok"}, model=${modelMissing ? "missing" : reasoningMissing ? "unsupported reasoning" : "ok"}, stderr=${(r.stderr ?? "").trim().slice(0, 160) || "empty"}`);
        break;
      }
    }
  }
  return {
    name: "profile runtime",
    status: problems.length ? "fail" : "pass",
    detail: `pi-profile-switch ${installed ?? "missing"}; private asset and scenario canaries verified across installed harnesses`,
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
  const checks = [checkComposition(), checkPi(), checkCodex(), checkAdapterContract(), checkProjections(), checkControlPlane(), checkProfileRuntime(), checkHygiene(), checkSettingsBoundary()];
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
