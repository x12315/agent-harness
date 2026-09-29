#!/usr/bin/env node
/**
 * Compile the neutral instruction/profile catalog into harness-native inputs.
 *
 * Sources:
 *   Markdown modules below instructions/{mandatory,repository,profile}/
 *   profiles/*.json
 *
 * Generated, tracked compatibility artifacts:
 *   AGENTS.md
 *   adapters/pi/profiles/*.json
 *   adapters/codex/profiles/*.config.toml
 *
 * Read-only by default. Pass --apply to update generated files. `inspect`
 * prints the declared effective harness without contacting either runtime.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, classify } from "./lib/repo.mjs";

const INSTRUCTIONS = join(REPO, "instructions");
const PROFILES = join(REPO, "profiles");
const PI_OUTPUT = join(REPO, "adapters/pi/profiles");
const CODEX_OUTPUT = join(REPO, "adapters/codex/profiles");
const AGENTS_OUTPUT = join(REPO, "AGENTS.md");
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const CODEX_THINKING = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const SANDBOX = new Set(["read-only", "workspace-write", "danger-full-access"]);
const APPROVAL = new Set(["on-request", "never"]);
const TOP_KEYS = new Set(["$schema", "label", "description", "instructions", "skills", "adapters"]);

function filesUnder(root, suffix) {
  const out = [];
  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(suffix)) out.push(path);
    }
  }
  walk(root);
  return out;
}

const moduleId = (path) => relative(INSTRUCTIONS, path).replace(/\.md$/, "").split("\\").join("/");

function readModules() {
  const modules = new Map();
  for (const path of filesUnder(INSTRUCTIONS, ".md")) {
    const id = moduleId(path);
    const content = readFileSync(path, "utf8").trim();
    if (!content) throw new Error(`${id}: instruction module is empty`);
    modules.set(id, { id, path, content });
  }
  return modules;
}

function assertStringArray(value, where) {
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string" || !x.trim())) {
    throw new Error(`${where}: expected an array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${where}: duplicate entries`);
}

function assertKeys(object, allowed, where) {
  if (object === null || typeof object !== "object" || Array.isArray(object)) throw new Error(`${where}: expected object`);
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${where}: unknown key(s): ${unknown.join(", ")}`);
}

function readProfiles(modules) {
  const profiles = new Map();
  for (const path of filesUnder(PROFILES, ".json")) {
    if (basename(path) === "profile.schema.json") continue;
    const name = basename(path, ".json");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name === "default") {
      throw new Error(`${name}: invalid or reserved profile name`);
    }
    let p;
    try { p = JSON.parse(readFileSync(path, "utf8")); }
    catch (error) { throw new Error(`${name}: invalid JSON: ${error.message}`); }
    assertKeys(p, TOP_KEYS, name);
    if (typeof p.label !== "string" || !p.label.trim()) throw new Error(`${name}.label: required string`);
    if (typeof p.description !== "string" || !p.description.trim()) throw new Error(`${name}.description: required string`);
    assertStringArray(p.instructions, `${name}.instructions`);
    for (const id of p.instructions) {
      if (!id.startsWith("profile/")) throw new Error(`${name}: selectable instruction must live under instructions/profile/: ${id}`);
      if (!modules.has(id)) throw new Error(`${name}: instruction module not found: ${id}`);
    }
    if (p.skills === undefined) throw new Error(`${name}.skills: required; use [\"*\"] for all or [] for none`);
    assertStringArray(p.skills, `${name}.skills`);

    const adapters = p.adapters;
    assertKeys(adapters, new Set(["pi", "codex"]), `${name}.adapters`);
    if (adapters.pi === undefined || adapters.codex === undefined) throw new Error(`${name}.adapters: pi and codex are required`);
    assertKeys(adapters.pi, new Set(["tools", "extensions", "mcps", "model"]), `${name}.adapters.pi`);
    for (const key of ["tools", "extensions", "mcps"]) {
      if (adapters.pi[key] !== undefined) assertStringArray(adapters.pi[key], `${name}.adapters.pi.${key}`);
    }
    if (adapters.pi.model !== undefined) {
      assertKeys(adapters.pi.model, new Set(["provider", "id", "thinking"]), `${name}.adapters.pi.model`);
      if (!adapters.pi.model.provider || !adapters.pi.model.id) throw new Error(`${name}.adapters.pi.model: provider and id are required`);
      if (adapters.pi.model.thinking !== undefined && !THINKING.has(adapters.pi.model.thinking)) throw new Error(`${name}.adapters.pi.model.thinking: unsupported value`);
    }
    assertKeys(adapters.codex, new Set(["sandbox", "approval", "model"]), `${name}.adapters.codex`);
    if (adapters.codex.model !== undefined) {
      assertKeys(adapters.codex.model, new Set(["id", "thinking"]), `${name}.adapters.codex.model`);
      if (!adapters.codex.model.id) throw new Error(`${name}.adapters.codex.model.id: required`);
      if (adapters.codex.model.thinking !== undefined && !CODEX_THINKING.has(adapters.codex.model.thinking)) throw new Error(`${name}.adapters.codex.model.thinking: unsupported value`);
    }
    if (adapters.codex.sandbox !== undefined && !SANDBOX.has(adapters.codex.sandbox)) throw new Error(`${name}.adapters.codex.sandbox: unsupported value`);
    if (adapters.codex.approval !== undefined && !APPROVAL.has(adapters.codex.approval)) throw new Error(`${name}.adapters.codex.approval: unsupported value`);
    profiles.set(name, { name, path, ...p, adapters });
  }
  if (!profiles.size) throw new Error("no profiles declared");
  return profiles;
}

function globRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function resolveSkills(patterns, catalog, profileName) {
  if (patterns === undefined) return undefined;
  const selected = new Set();
  for (const pattern of patterns) {
    const matches = catalog.filter((name) => globRegex(pattern).test(name));
    if (!matches.length) throw new Error(`${profileName}: skill reference matches nothing: ${pattern}`);
    for (const name of matches) selected.add(name);
  }
  return [...selected].sort();
}

function renderAgents(modules) {
  const ids = [...modules.keys()].filter((id) => id.startsWith("mandatory/") || id.startsWith("repository/")).sort();
  const index = ids.map((id) => `- \`${id}\``).join("\n");
  const body = ids.map((id) => `<!-- instruction:${id} -->\n${modules.get(id).content}`).join("\n\n");
  return `# AGENTS.md\n\n<!-- GENERATED by scripts/compose.mjs. Edit instructions/, not this file. -->\n\n## 常驻 instruction modules\n\n${index}\n\n${body}\n`;
}

function profileInstructions(profile, modules) {
  return profile.instructions.map((id) => modules.get(id).content).join("\n\n");
}

function renderPi(profile, modules, skillCatalog) {
  const out = {
    label: profile.label,
    description: profile.description,
  };
  const selected = resolveSkills(profile.skills, skillCatalog, profile.name);
  if (selected !== undefined) out.skills = selected;
  for (const key of ["extensions", "mcps", "tools"]) {
    if (profile.adapters.pi[key] !== undefined) out[key] = profile.adapters.pi[key];
  }
  const model = profile.adapters.pi.model;
  if (model !== undefined) {
    out.defaultProvider = model.provider;
    out.defaultModel = model.id;
    if (model.thinking !== undefined) out.defaultThinkingLevel = model.thinking;
  }
  const instructions = profileInstructions(profile, modules);
  if (instructions) out.instructions = instructions;
  return `${JSON.stringify(out, null, 2)}\n`;
}

const tomlString = (value) => JSON.stringify(value);

function renderCodex(profile, modules, skillCatalog) {
  const lines = [
    "# GENERATED by scripts/compose.mjs. Edit profiles/ or instructions/, not this file.",
  ];
  const model = profile.adapters.codex.model;
  if (model !== undefined) {
    lines.push(`model = ${tomlString(model.id)}`);
    if (model.thinking !== undefined) lines.push(`model_reasoning_effort = ${tomlString(model.thinking)}`);
  }
  const adapter = profile.adapters.codex;
  if (adapter.sandbox !== undefined) lines.push(`sandbox_mode = ${tomlString(adapter.sandbox)}`);
  if (adapter.approval !== undefined) lines.push(`approval_policy = ${tomlString(adapter.approval)}`);
  const instructions = profileInstructions(profile, modules);
  if (instructions) lines.push(`developer_instructions = ${tomlString(instructions)}`);

  const selected = resolveSkills(profile.skills, skillCatalog, profile.name);
  if (selected !== undefined) {
    const enabled = new Set(selected);
    for (const skill of skillCatalog) {
      lines.push("", "[[skills.config]]", `path = ${tomlString(`~/.agents/skills/${skill}/SKILL.md`)}`, `enabled = ${enabled.has(skill)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function compose() {
  const modules = readModules();
  const profiles = readProfiles(modules);
  const state = classify();
  const skillCatalog = [...new Set([...state.declared, ...state.own])].sort();
  const outputs = new Map([[AGENTS_OUTPUT, renderAgents(modules)]]);
  for (const profile of profiles.values()) {
    outputs.set(join(PI_OUTPUT, `${profile.name}.json`), renderPi(profile, modules, skillCatalog));
    outputs.set(join(CODEX_OUTPUT, `${profile.name}.config.toml`), renderCodex(profile, modules, skillCatalog));
  }
  return { modules, profiles, skillCatalog, outputs };
}

function generatedFiles() {
  return [
    ...filesUnder(PI_OUTPUT, ".json"),
    ...filesUnder(CODEX_OUTPUT, ".config.toml"),
  ];
}

export function inspect(profileName, { json = false } = {}) {
  const state = compose();
  const names = profileName ? [profileName] : [...state.profiles.keys()].sort();
  const missing = names.filter((name) => !state.profiles.has(name));
  if (missing.length) throw new Error(`unknown profile: ${missing.join(", ")}`);
  const core = [...state.modules.keys()].filter((id) => id.startsWith("mandatory/") || id.startsWith("repository/")).sort();
  const reports = names.map((name) => {
    const p = state.profiles.get(name);
    return {
      name,
      label: p.label,
      description: p.description,
      coreInstructions: core,
      profileInstructions: p.instructions,
      skills: p.skills === undefined ? "inherited (all discovered)" : resolveSkills(p.skills, state.skillCatalog, name),
      adapters: p.adapters,
    };
  });
  if (json) console.log(JSON.stringify(reports, null, 2));
  else {
    for (const r of reports) {
      console.log(`profile  ${r.name} — ${r.label}`);
      console.log(`  ${r.description}`);
      console.log(`  core instructions: ${r.coreInstructions.join(", ")}`);
      console.log(`  profile instructions: ${r.profileInstructions.join(", ") || "(none)"}`);
      console.log(`  skills: ${Array.isArray(r.skills) ? `[${r.skills.join(", ")}]` : r.skills}`);
      console.log(`  pi: model=${r.adapters.pi.model ? `${r.adapters.pi.model.provider}/${r.adapters.pi.model.id}${r.adapters.pi.model.thinking ? `:${r.adapters.pi.model.thinking}` : ""}` : "inherit"} tools=${r.adapters.pi.tools ? `[${r.adapters.pi.tools.join(", ")}]` : "inherit"}`);
      console.log(`  codex: model=${r.adapters.codex.model ? `${r.adapters.codex.model.id}${r.adapters.codex.model.thinking ? `:${r.adapters.codex.model.thinking}` : ""}` : "inherit"} sandbox=${r.adapters.codex.sandbox ?? "inherit"}`);
    }
  }
  return reports;
}

export function run({ apply = false, json = false } = {}) {
  let state;
  try { state = compose(); }
  catch (error) {
    if (json) console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    else console.error(`compose: FAILED - ${error.message}`);
    return 1;
  }
  const expected = new Set(state.outputs.keys());
  const stale = generatedFiles().filter((path) => !expected.has(path));
  const changes = [];
  for (const [path, content] of state.outputs) {
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (current !== content) changes.push({ path, action: current === null ? "create" : "update" });
  }
  for (const path of stale) changes.push({ path, action: "remove" });

  if (apply) {
    for (const path of stale) rmSync(path, { force: true });
    for (const [path, content] of state.outputs) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
  }
  const ok = apply || changes.length === 0;
  if (json) {
    console.log(JSON.stringify({ ok, apply, modules: state.modules.size, profiles: state.profiles.size, changes: changes.map((x) => ({ ...x, path: relative(REPO, x.path) })) }, null, 2));
  } else {
    for (const change of changes) console.log(`${apply ? "done" : "todo"}  ${change.action.padEnd(6)} ${relative(REPO, change.path)}`);
    console.log(`compose: ${ok ? "OK" : "pending"} (${state.modules.size} modules, ${state.profiles.size} profiles)${apply ? "" : "  [read-only; add --apply to write]"}`);
  }
  return ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args[0] === "inspect") {
    try { inspect(args.find((arg, index) => index > 0 && !arg.startsWith("-")), { json: args.includes("--json") }); }
    catch (error) { console.error(`inspect: FAILED - ${error.message}`); process.exitCode = 1; }
  } else {
    process.exitCode = run({ apply: args.includes("--apply"), json: args.includes("--json") });
  }
}
