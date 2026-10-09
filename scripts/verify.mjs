#!/usr/bin/env node
/**
 * Post-change checks. Read-only.
 *   1. instruction/profile outputs match their neutral sources
 *   2. pi and Codex discover the shared catalog without warnings
 *   3. adapter imports still match installed Pi exports
 *   4. every managed projection resolves into this repo
 *   5. the human control plane bypasses the model under a read-only Profile
 *   6. the pinned profile runtime and cross-harness canary work
 *   7. subagents cannot exceed the parent Profile's active tool set
 *   8. repo hygiene and settings ownership boundaries hold
 *
 * A check is skipped, not failed, when its harness is not installed - the repo
 * has to stay usable on a machine that only runs one of them.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildAgentToolArgs } from "../adapters/pi/extensions/subagent/tool-policy.mjs";
import { compose } from "./compose.mjs";
import { checkAdapterContract } from "./lib/adapter-contract.mjs";
import { mapChecks, runCheckCommand } from "./lib/check-runner.mjs";
import { ENGINE, ENGINEERING_SETTING_KEYS, HOME, LOCAL_PI_SETTINGS, PI_PROFILE_CONFIG_SKILL, REPO, SHARED_PI_SETTINGS, engineeringPiSettings, isInsideRepo, isSymlink, managedLinks, pins, projectionSource, readJson, staleManagedLinks } from "./lib/repo.mjs";

const PI_RUNTIME_PROBE = join(ENGINE, "scripts/probes/pi-runtime.ts");

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

async function checkPi() {
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
  const r = await runCheckCommand("pi", ["--mode", "rpc"], {
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
  else if (![harnessCommands[0].sourceInfo?.path, harnessCommands[0].path].filter(Boolean).map(canon).some((p) => p.startsWith(canon(ENGINE) + "/"))) {
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
    if (!pointer.trim()) problems.push("Catalog Codex entry is empty; shared rules must also be compiled into each Profile");
  }
  return {
    name: "codex entry",
    status: problems.length ? "fail" : "pass",
    detail: problems.length ? "codex cannot reach the shared instruction layer" : "AGENTS.md projected into $CODEX_HOME",
    problems,
  };
}

function checkProjections() {
  const problems = staleManagedLinks().map((target) => `${target}: stale managed projection; run harness bootstrap --apply`);
  for (const [src, target] of managedLinks()) {
    if (!existsSync(projectionSource(src))) { problems.push(`${src}: source missing in repo`); continue; }
    if (!existsSync(target)) { problems.push(`${target}: projection missing`); continue; }
    if (!isSymlink(target)) { problems.push(`${target}: not a symlink (something rewrote it)`); continue; }
    let real = "";
    try { real = realpathSync(target); } catch { problems.push(`${target}: dangling`); continue; }
    if (real !== canon(projectionSource(src))) problems.push(`${target}: does not point to its declared engine/Catalog source -> ${real}`);
  }
  const stray = [];
  // The claude probe used to open an interactive session instead of answering,
  // so this check deliberately stays offline: a plain symlink needs no probe.
  for (const root of [join(HOME, ".pi/agent")]) sweepSymlinks(root, 0, stray);
  for (const s of stray) problems.push(`symlink into an upstream install: ${s}`);
  return {
    name: "projections",
    status: problems.length ? "fail" : "pass",
    detail: `${managedLinks().length} managed projections are symlinks to their exact engine/Catalog sources`,
    problems,
  };
}

function checkSubagentToolBoundary() {
  const cases = [
    { parent: ["read", "subagent"], agent: ["read", "bash"], expected: ["--tools", "read"] },
    { parent: ["subagent"], agent: ["bash"], expected: ["--no-tools"] },
    { parent: ["read", "edit", "subagent"], agent: undefined, expected: ["--tools", "read,edit"] },
  ];
  const problems = [];
  for (const test of cases) {
    const actual = buildAgentToolArgs(test.parent, test.agent);
    if (JSON.stringify(actual) !== JSON.stringify(test.expected)) {
      problems.push(`parent=${test.parent.join(",")} agent=${test.agent?.join(",") ?? "inherit"}: got ${actual.join(" ") || "none"}`);
    }
  }
  return {
    name: "subagent boundary",
    status: problems.length ? "fail" : "pass",
    detail: problems.length ? "a child Agent can exceed its parent tool policy" : "child tools are intersected with the parent Profile allowlist",
    problems,
  };
}

async function checkControlPlane({ serial = false } = {}) {
  const target = join(HOME, ".local/bin/harness");
  const problems = [];
  if (!existsSync(target)) problems.push(`${target}: missing; run node scripts/harness.mjs install`);
  else {
    const r = await runCheckCommand(target, ["status", "--json"], { encoding: "utf8", timeout: 30_000 });
    let report;
    try { report = JSON.parse(r.stdout); } catch { /* reported below */ }
    if (r.status !== 0 || !report?.ok) problems.push((r.stderr || report?.error || "harness status failed").trim());
    else if (!Array.isArray(report.profiles) || report.profiles.length === 0) problems.push("harness status returned no profiles");
  }
  if (!problems.length && have("pi")) {
    const loop = await runCheckCommand(process.execPath, [join(ENGINE, "scripts/test-control-plane.mjs"), "--no-tui", ...(serial ? ["--serial"] : [])], { encoding: "utf8", timeout: 150_000, killSignal: "SIGKILL" });
    if (loop.status !== 0) problems.push((loop.stderr || loop.stdout || "control-plane loop failed").trim());
  }
  return {
    name: "control plane",
    status: problems.length ? "fail" : "pass",
    detail: problems.length ? "human management entry is unavailable" : "harness CLI and status report are operational",
    problems,
  };
}

async function checkControlPlaneCanary() {
  if (!have("pi") || !have("pi-profile")) return { name: "control canary", status: "skip", detail: "pi or pi-profile not installed" };
  const result = await runCheckCommand(process.execPath, [join(ENGINE, "scripts/control-plane-canary.mjs")], { timeout: 75_000, killSignal: "SIGKILL" });
  return {
    name: "control canary", status: result.status === 0 ? "pass" : "fail",
    detail: "real Profile /harness RPC, zero model turns",
    problems: result.status === 0 ? [] : [(result.stderr || result.stdout || result.error?.message || "control-plane canary failed").trim()],
  };
}

function checkComposition() {
  const r = spawnSync(process.execPath, [join(ENGINE, "scripts/compose.mjs")], { env: { ...process.env, HARNESS_CATALOG: REPO }, encoding: "utf8", timeout: 30_000 });
  const detail = `${instructionEntryCount(join(REPO, "instructions"))} instruction entries, ${filesCount(join(REPO, "profiles"), ".json", "profile.schema.json")} profiles`;
  return {
    name: "composition",
    status: r.status === 0 ? "pass" : "fail",
    detail: r.status === 0 ? `${detail}; generated adapters are current` : `${detail}; generated artifacts drifted`,
    problems: r.status === 0 ? [] : [(r.stdout || r.stderr || "compose failed").trim().split("\n").slice(0, 4).join("; ")],
  };
}

function instructionEntryCount(root) {
  if (!existsSync(root)) return 0;
  let count = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) count += instructionEntryCount(path);
    else if (entry.name.endsWith(".md") && !entry.name.endsWith(".brief.md") && !entry.name.endsWith(".detailed.md")) count += 1;
  }
  return count;
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

async function checkProfileRuntime({ profiles, adapters = ["pi", "codex"], serial = false } = {}) {
  const problems = [];
  let installed = null;
  if (adapters.includes("pi")) {
    const expected = pins().piProfileSwitch;
    const npmRoot = await runCheckCommand("npm", ["root", "--global"], { timeout: 30_000 });
    let packageRoot = "";
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
  }

  // Runtime expectations come from the current declarations, not the shipped
  // presets, so user tuning remains valid while adapter drift is still caught.
  let catalog;
  if (!problems.length) {
    try { catalog = compose(); }
    catch (error) { problems.push(`cannot load profile catalog: ${error.message}`); }
  }
  const selectedProfiles = profiles ?? [...(catalog?.profiles.keys() ?? [])].sort();
  for (const name of selectedProfiles) if (catalog && !catalog.profiles.has(name)) problems.push(`unknown profile: ${name}`);
  if (profiles) for (const adapter of adapters) if (!have(adapter)) problems.push(`${adapter} is not installed; targeted verification cannot run`);
  if (adapters.includes("pi") && !problems.length && have("pi")) {
    let defaultBuiltinTools = [];
    if (selectedProfiles.some((name) => catalog.profiles.get(name).adapters.pi.tools === undefined)) {
      defaultBuiltinTools = undefined;
      const baseRuntime = await runCheckCommand("pi", ["--offline", "--extension", PI_RUNTIME_PROBE, "--mode", "rpc", "--no-session"], {
        input: '{"id":"tools","type":"prompt","message":"/harness-runtime-probe"}\n', encoding: "utf8", timeout: 180_000,
      });
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
    }
    for (const profile of !problems.length ? selectedProfiles : []) {
      const generated = readJson(join(REPO, `adapters/pi/profiles/${profile}.json`));
      const encodedInstruction = Buffer.from(generated.instructions ?? "", "utf8").toString("base64");
      const input = [
        '{"id":"commands","type":"get_commands"}',
        JSON.stringify({ id: "tools", type: "prompt", message: `/harness-runtime-probe ${encodedInstruction}` }),
        "",
      ].join("\n");
      // Test the Profile recommendation, not a user's persisted scoped-model filter.
      // Widen only the canary process scope; do not override its model/thinking or write settings.
      const r = await runCheckCommand("pi-profile", [profile, "--", "--offline", "--models", "*", "--extension", PI_RUNTIME_PROBE, "--mode", "rpc", "--no-session"], {
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
  if (adapters.includes("codex") && !problems.length && have("codex")) {
    const modelsResult = await runCheckCommand("codex", ["debug", "models"], { encoding: "utf8", timeout: 120_000 });
    let codexModels = [];
    try { codexModels = JSON.parse(modelsResult.stdout ?? "{}").models ?? []; }
    catch { /* reported below */ }
    if (modelsResult.status !== 0 || (modelsResult.stderr ?? "").trim() || !codexModels.length) {
      problems.push(`Codex model catalog unavailable: ${(modelsResult.stderr ?? "").trim().slice(0, 160) || "empty model list"}`);
    }
    const codexProfiles = problems.length ? [] : selectedProfiles;
    const prompts = await mapChecks(codexProfiles, (profile) => runCheckCommand("codex", ["-p", profile, "debug", "prompt-input", "profile canary"], { timeout: 120_000 }), serial ? 1 : 3);
    for (const [index, profile] of codexProfiles.entries()) {
      const declaration = catalog.profiles.get(profile);
      const generated = readJson(join(REPO, `adapters/pi/profiles/${profile}.json`));
      const expectedSkills = generated.skills ?? [];
      const excludedSkills = catalog.skillCatalog.filter((name) => !expectedSkills.includes(name));
      const r = prompts[index];
      let text = "";
      try {
        text = JSON.parse(r.stdout ?? "[]")
          .flatMap((message) => message.content ?? [])
          .map((content) => content.text ?? "")
          .join("\n");
      } catch { /* reported as a runtime mismatch below */ }
      const missingSkills = expectedSkills.filter((name) => !text.includes(`(file: r0/${name}/SKILL.md)`));
      const missingInstructions = declaration.instructions
        .filter((selection) => !text.includes(catalog.modules.get(selection.id).variants[selection.detail].content))
        .map((selection) => `${selection.id}@${selection.detail}`);
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
        : approval === "on-request" && !text.includes("`approvals_reviewer` is `auto_review`");
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
    name: adapters.length === 1 ? `${adapters[0]} runtime` : "profile runtime",
    status: problems.length ? "fail" : "pass",
    detail: `${adapters.join("+")} runtime; profiles=[${selectedProfiles.join(", ")}]${adapters.includes("pi") ? `; pi-profile-switch ${installed ?? "missing"}` : ""}`,
    problems,
  };
}

function checkHygiene() {
  const problems = [];
  if (ENGINE !== REPO) for (const path of ["instructions", "profiles", "skills", ".skill-lock.json"]) {
    if (existsSync(join(ENGINE, path))) problems.push(`Engine contains personal Catalog content: ${path}`);
  }
  for (const root of new Set([ENGINE, REPO])) {
    const r = spawnSync("git", ["-C", root, "ls-files", "-s"], { encoding: "utf8" });
    if (r.status !== 0) { problems.push(`source is not a Git checkout: ${root}`); continue; }
    for (const line of (r.stdout ?? "").split("\n")) {
      if (!line.trim()) continue;
      const [meta, path] = line.split("\t");
      if ((meta ?? "").startsWith("120000")) problems.push(`committed symlink: ${root}/${path}`);
      if (path.includes("node_modules/")) problems.push(`node_modules tracked: ${root}/${path}`);
      if (/(^|\/)(auth|credential|credentials|token|tokens|secret|secrets)\.(json|ya?ml|txt)$/i.test(path) || /\.(pem|key)$/i.test(path)) {
        problems.push(`possible secret: ${root}/${path}`);
      }
    }
  }
  return {
    name: "repo hygiene",
    status: problems.length ? "fail" : "pass",
    detail: "both source repos are cleanly separated; no symlinks, node_modules or secrets committed",
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

/** Parse opt-in atomic checks; malformed scopes must never silently run or skip the full suite. */
export function verificationOptions(args) {
  const catalogOnly = args.includes("--catalog");
  const runtime = args.filter((arg) => arg.startsWith("--runtime="));
  const profiles = args.filter((arg) => arg.startsWith("--profile=")).map((arg) => arg.slice(10));
  const execution = args.includes("--serial") ? { serial: true } : {};
  if (args.some((arg) => arg.startsWith("--") && arg !== "--json" && arg !== "--serial" && arg !== "--catalog" && !arg.startsWith("--runtime=") && !arg.startsWith("--profile="))) throw new Error("Unknown verification option");
  if (catalogOnly && (runtime.length || profiles.length)) throw new Error("--catalog cannot be combined with runtime checks");
  if (runtime.length || profiles.length) {
    if (runtime.length !== 1 || !["--runtime=pi", "--runtime=codex"].includes(runtime[0]) || !profiles.length || profiles.some((name) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))) throw new Error("Use --runtime=pi|codex with one or more --profile=<id>");
    return { ...execution, profiles: [...new Set(profiles)], adapters: [runtime[0].slice(10)] };
  }
  return { ...execution, catalogOnly };
}

/** Run all release checks by default, or explicit Catalog/adapter checks without regression tests. */
export async function run({ json = false, catalogOnly = false, profiles, adapters, serial = false } = {}) {
  const started = performance.now();
  const measure = async (job) => {
    const before = performance.now();
    const result = await job();
    return { ...result, durationMs: Math.round(performance.now() - before) };
  };
  let checks;
  if (catalogOnly || profiles) {
    const jobs = catalogOnly ? [checkComposition, checkProjections] : [() => checkProfileRuntime({ profiles, adapters, serial })];
    checks = await mapChecks(jobs, measure, 1);
  } else {
    const staticChecks = await mapChecks([checkComposition, checkCodex, checkAdapterContract, checkProjections, checkSubagentToolBoundary, checkHygiene, checkSettingsBoundary], measure, 1);
    const piLane = async () => mapChecks([checkPi, checkControlPlaneCanary, () => checkProfileRuntime({ adapters: ["pi"], serial })], measure, 1);
    const lanes = await mapChecks([
      piLane,
      async () => [await measure(() => checkControlPlane({ serial }))],
      async () => [await measure(() => checkProfileRuntime({ adapters: ["codex"], serial }))],
    ], (lane) => lane(), serial ? 1 : 3);
    checks = [...staticChecks, ...lanes.flat()];
  }
  const notes = catalogOnly || profiles ? [] : observedVersions();
  const ok = checks.every((c) => c.status !== "fail");
  if (json) {
    console.log(JSON.stringify({ ok, checks, notes, durationMs: Math.round(performance.now() - started), execution: serial ? "serial" : "bounded parallel" }, null, 2));
  } else {
    for (const c of checks) {
      const mark = c.status === "pass" ? "ok  " : c.status === "skip" ? "skip" : "FAIL";
      console.log(`${mark}  ${c.name.padEnd(16)} ${c.detail} (${(c.durationMs / 1000).toFixed(3)}s)`);
      for (const p of c.problems ?? []) console.log(`        ! ${p}`);
    }
    for (const n of notes) console.log(`note  ${n}`);
    console.log(`${ok ? "verify: OK" : "verify: FAILED"} (${((performance.now() - started) / 1000).toFixed(3)}s; ${serial ? "serial" : "bounded parallel"})`);
  }
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await run({ json: process.argv.includes("--json"), ...verificationOptions(process.argv.slice(2)) }); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
