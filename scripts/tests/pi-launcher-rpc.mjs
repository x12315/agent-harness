#!/usr/bin/env node
// Real launcher + native Pi reload. Isolated HOME/Catalog; no authentication is copied and no model turn is submitted.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ENGINE } from "../lib/repo.mjs";
import { createWebFixture } from "./web-fixture.mjs";

const root = realpathSync(createWebFixture());
const home = join(root, "home");
const env = { ...process.env, HOME: home, HARNESS_CATALOG: root, PI_OFFLINE: "1" };
delete env.PI_CODING_AGENT_DIR;
delete env.PI_PROFILE_SWITCH_DIR;
delete env.HARNESS_ENGINE_ENTRY;
for (const key of Object.keys(env)) if (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) delete env[key];
let child;
let stderr = "";
const pending = new Map();
const events = [];
let sequence = 0;
const kill = () => { if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } } };
const deadline = setTimeout(kill, 35_000);
try {
  rmSync(join(root, "adapters/pi/extensions"), { recursive: true });
  mkdirSync(join(root, "adapters/pi/extensions"));
  mkdirSync(join(root, "adapters/codex"), { recursive: true });
  writeFileSync(join(root, "adapters/codex/AGENTS.md"), "Fixture Codex entry.\n");
  writeFileSync(join(root, "adapters/pi/settings.json"), JSON.stringify({ packages: [], skills: ["-{{HOME}}/.pi/agent/skills/profile-config/SKILL.md"] }));
  writeFileSync(join(root, "adapters/pi/extensions/ordinary-marker.ts"), 'export default function(pi) { pi.registerCommand("ordinary-marker", {description:"ordinary-only fixture",handler:async()=>{}}); }');
  for (const [name, tools] of [["medium", ["read"]], ["heavy", []], ["ultralight", ["read"]]]) {
    const path = join(root, "profiles", name + ".json"), value = JSON.parse(readFileSync(path, "utf8"));
    delete value.adapters.pi.model;
    value.adapters.pi.tools = tools;
    writeFileSync(path, JSON.stringify(value));
  }
  const invoke = args => execFileSync(process.execPath, [join(ENGINE, "bin/harness"), ...args], { env, cwd: root, encoding: "utf8", timeout: 15_000 });
  invoke(["compose", "--apply"]);
  invoke(["bootstrap", "--apply"]);
  mkdirSync(join(home, ".pi/agent/skills"), { recursive: true });
  for (const skill of ["short-skill", "long-skill"]) symlinkSync(join(root, "skills", skill), join(home, ".pi/agent/skills", skill));
  // A real unwanted skill verifies exclusion even though pi-profile installs its own starter assets.
  mkdirSync(join(home, ".pi/agent/skills/profile-config"), { recursive: true });
  writeFileSync(join(home, ".pi/agent/skills/profile-config/SKILL.md"), "---\nname: profile-config\ndescription: Unwanted private configuration fixture.\n---\n\nNever use this fixture.\n");
  const settingsPath = join(home, ".pi/agent/settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  Object.assign(settings, { theme: "light", defaultProvider: "openai", defaultModel: "gpt-5", defaultThinkingLevel: "low", enabledModels: ["openai/gpt-5*"], defaultProjectTrust: "never" });
  writeFileSync(settingsPath, JSON.stringify(settings));
  const beforeSettings = readFileSync(settingsPath, "utf8");
  const savedPath = join(home, ".pi-profile-switch/pi-profile-state.json");
  writeFileSync(savedPath, JSON.stringify({ activeProfile: "heavy" }));
  const probe = join(root, "launch-probe.ts");
  writeFileSync(probe, `import {readFileSync} from 'node:fs';import {join} from 'node:path';
export default function(pi) {let plan;pi.on('session_start',()=>{plan=JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR,'pi-profile.json'),'utf8'));});pi.registerCommand('launch-probe',{description:'fixture probe',handler:async(_args,ctx)=>{const settings=JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR,'settings.json'),'utf8'));ctx.ui.notify('LAUNCH-PROBE '+JSON.stringify({profile:plan?.profile,source:plan?.source,tools:pi.getActiveTools(),prompt:ctx.getSystemPrompt(),settings:{theme:settings.theme,enabledModels:settings.enabledModels},cwd:ctx.cwd}));}});}`);
  child = spawn(process.execPath, [join(ENGINE, "bin/pi-h"), "--offline", "--no-session", "--mode", "rpc", "--model", "openai/gpt-5.2", "--thinking", "high", "--extension", probe], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const closed = new Promise(resolve => child.once("close", (code, signal) => { for (const { reject } of pending.values()) reject(new Error(`Pi exited ${code}/${signal}: ${stderr}`)); pending.clear(); resolve({ code, signal }); }));
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  child.stdout.on("data", chunk => {
    buffer += decoder.write(chunk);
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n"), line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line); events.push(event);
        if (event.type === "agent_start") { kill(); throw new Error("unexpected model turn"); }
        const request = pending.get(event.id);
        if (event.type === "response" && request) { pending.delete(event.id); event.success ? request.resolve(event) : request.reject(new Error(JSON.stringify(event))); }
      } catch (error) { for (const { reject } of pending.values()) reject(error); pending.clear(); kill(); }
    }
  });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const request = (type, extra = {}) => new Promise((resolve, reject) => { const id = `launch-${sequence++}`; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n"); });
  const waitEvent = async (start, predicate) => {
    for (let attempt = 0; attempt < 125; attempt++) {
      const event = events.slice(start).find(predicate);
      if (event) return event;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(`Expected RPC event was not delivered: ${JSON.stringify(events.slice(start))}`);
  };
  const switchWork = async (from, name) => {
    const start = events.length;
    await request("prompt", { message: `/harness switch ${name}` });
    await waitEvent(start, event => event.message?.startsWith(`profile switched: ${from} → ${name}`));
  };
  const snapshot = async () => {
    const start = events.length;
    await request("prompt", { message: "/launch-probe" });
    // RPC prompt responses mean preflight accepted, not that the async extension handler has completed.
    const event = await waitEvent(start, event => event.message?.startsWith("LAUNCH-PROBE "));
    return JSON.parse(event.message.slice("LAUNCH-PROBE ".length));
  };
  const commands = async () => (await request("get_commands")).data.commands.map(command => command.name);
  const initial = await snapshot();
  assert.equal(initial.profile, "default", "saved selection must not change ordinary entry");
  assert.equal(initial.source, "builtin");
  const startupHint = events.find(event => event.method === "setWidget" && event.widgetKey === "harness-profile-hint" && event.widgetLines?.length);
  assert.ok(startupHint, "ordinary entry must guide users to choose a work profile");
  assert.match(startupHint.widgetLines.join("\n"), /尚未选择工作方案/);
  assert.match(startupHint.widgetLines.join("\n"), /\/harness switch/);
  assert.equal(events.filter(event => event.method === "setStatus" && event.statusKey === "profile").at(-1)?.statusText, "普通模式 · 未选择工作方案");
  assert.equal(initial.cwd, root);
  assert.equal(initial.settings.theme, "light");
  assert.deepEqual(initial.settings.enabledModels, settings.enabledModels);
  const state = (await request("get_state")).data;
  assert.equal(state.model.id, "gpt-5.2"); assert.equal(state.thinkingLevel, "high");
  const firstCommands = await commands();
  assert.equal(firstCommands.filter(name => name === "harness").length, 1, "Harness must load once");
  assert.ok(firstCommands.includes("profile") && firstCommands.includes("ordinary-marker"));
  assert.ok(firstCommands.includes("skill:short-skill") && firstCommands.includes("skill:long-skill"));
  assert.ok(!firstCommands.includes("skill:profile-config"));
  assert.equal(JSON.parse(readFileSync(savedPath, "utf8")).activeProfile, "heavy", "ordinary startup must not persist default");
  await switchWork("default", "medium");
  // The plan is written before reload finishes. Readiness must include live policy, not just the file's profile name.
  let medium;
  for (let attempt = 0; attempt < 50; attempt++) { await new Promise(resolve => setTimeout(resolve, 40)); medium = await snapshot(); if (medium.profile === "medium" && JSON.stringify(medium.tools) === '["read"]' && /Standard Implementation\./.test(medium.prompt)) break; }
  assert.equal(medium.profile, "medium", JSON.stringify(events.slice(-10)));
  assert.deepEqual(medium.tools, ["read"]);
  assert.equal(events.filter(event => event.method === "setWidget" && event.widgetKey === "harness-profile-hint").at(-1)?.widgetLines, undefined, "selected work profiles clear the startup guidance");
  assert.equal(events.filter(event => event.method === "setStatus" && event.statusKey === "profile").at(-1)?.statusText, "profile: medium", "named profiles keep upstream status instead of the ordinary-mode label");
  assert.match(medium.prompt, /Standard Implementation\./);
  const after = await commands();
  assert.ok(after.includes("harness") && after.includes("skill:short-skill"));
  assert.ok(!after.includes("ordinary-marker") && !after.includes("skill:long-skill"), JSON.stringify(after));
  assert.ok(after.includes("skill:profile-config"), "record the pinned upstream's mandatory named-profile skill; do not claim it is removed");
  assert.equal((await request("get_state")).data.sessionId, state.sessionId, "reload must preserve the session");
  const failedStart = events.length;
  await request("prompt", { message: "/profile use missing-fixture-profile" });
  await waitEvent(failedStart, event => event.notifyType === "error" && event.message?.includes("missing-fixture-profile"));
  assert.equal((await snapshot()).profile, "medium", "failed switch must retain the active environment");
  await switchWork("medium", "heavy");
  let heavy;
  for (let attempt = 0; attempt < 50; attempt++) { await new Promise(resolve => setTimeout(resolve, 40)); heavy = await snapshot(); if (heavy.profile === "heavy" && heavy.tools.length === 0) break; }
  assert.equal(heavy.profile, "heavy"); assert.deepEqual(heavy.tools, []);
  assert.ok((await commands()).includes("harness"), "human control plane survives a zero-tool profile");
  await request("new_session");
  assert.deepEqual((await snapshot()).tools, [], "new sessions retain the profile tool policy");
  // Do not claim the upstream default transition restores built-in tools: start a fresh pi-h for ordinary mode.
  await switchWork("heavy", "medium");
  let restored;
  for (let attempt = 0; attempt < 50; attempt++) { await new Promise(resolve => setTimeout(resolve, 40)); restored = await snapshot(); if (restored.profile === "medium" && JSON.stringify(restored.tools) === '["read"]') break; }
  assert.equal(restored.profile, "medium");
  assert.deepEqual(restored.tools, ["read"], "switching between work profiles restores their declared tools");
  assert.equal(readFileSync(settingsPath, "utf8"), beforeSettings, "settings must remain untouched");
  assert.equal(events.some(event => event.type === "agent_start" || event.type === "extension_error"), false);
  // No authentication is seeded, so the scoped available-model list is empty even though explicit CLI model selection works.
  assert.ok(stderr.trim(), "isolated model scope should report unavailable credentials");
  for (const line of stderr.trim().split("\n")) assert.match(line, /^Warning: No models match pattern "openai\/gpt-5\*"$/);
  child.stdin.end();
  assert.deepEqual(await closed, { code: 0, signal: null });
  console.log("Pi launcher RPC: OK (default, native arguments, settings/scope, hot switch, resource removal, same session, failed switch, zero tools; model_requests=0)");
} finally {
  clearTimeout(deadline);
  kill();
  rmSync(root, { recursive: true, force: true });
}
