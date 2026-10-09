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
import { ENGINE, HOME, REPO, assertCatalog, classify } from "./lib/repo.mjs";

const INSTRUCTIONS = join(REPO, "instructions");
const PROFILES = join(REPO, "profiles");
const PI_OUTPUT = join(REPO, "adapters/pi/profiles");
const CODEX_OUTPUT = join(REPO, "adapters/codex/profiles");
const AGENTS_OUTPUT = join(REPO, "AGENTS.md");
const INSTRUCTION_SELECTION = join(INSTRUCTIONS, "selection.json");
const DETAIL_LEVELS = new Set(["brief", "standard", "detailed"]);
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

function instructionVariant(path, instructions = INSTRUCTIONS) {
  const relativePath = relative(instructions, path).split("\\").join("/");
  const match = relativePath.match(/^(.*)\.(brief|detailed)\.md$/);
  return match
    ? { id: match[1], detail: match[2] }
    : { id: relativePath.replace(/\.md$/, ""), detail: "standard" };
}

function readModules(instructions = INSTRUCTIONS) {
  const modules = new Map();
  for (const path of filesUnder(instructions, ".md")) {
    const { id, detail } = instructionVariant(path, instructions);
    if (!/^(mandatory|repository|profile)\/[a-z0-9][a-z0-9_-]*$/.test(id)) {
      throw new Error(`${id}: instruction entries must be one file level below their layer`);
    }
    const content = readFileSync(path, "utf8").trim();
    if (!content) throw new Error(`${id}@${detail}: instruction variant is empty`);
    const module = modules.get(id) ?? { id, layer: id.split("/")[0], variants: {} };
    if (module.variants[detail]) throw new Error(`${id}: duplicate ${detail} variant`);
    module.variants[detail] = { path, content };
    modules.set(id, module);
  }
  for (const module of modules.values()) {
    for (const detail of DETAIL_LEVELS) {
      if (!module.variants[detail]) throw new Error(`${module.id}: missing ${detail} variant`);
    }
  }
  return modules;
}

function assertInstructionSelections(value, where, expectedLayer, modules) {
  if (!Array.isArray(value)) throw new Error(`${where}: expected an array`);
  const seen = new Set();
  return value.map((selection, index) => {
    assertKeys(selection, new Set(["id", "detail"]), `${where}[${index}]`);
    if (typeof selection.id !== "string" || !selection.id.trim()) throw new Error(`${where}[${index}].id: required string`);
    if (!DETAIL_LEVELS.has(selection.detail)) throw new Error(`${where}[${index}].detail: expected brief, standard, or detailed`);
    if (seen.has(selection.id)) throw new Error(`${where}: duplicate instruction ${selection.id}`);
    seen.add(selection.id);
    const module = modules.get(selection.id);
    if (!module) throw new Error(`${where}: instruction entry not found: ${selection.id}`);
    if (module.layer !== expectedLayer) throw new Error(`${where}: instruction must live under instructions/${expectedLayer}/: ${selection.id}`);
    return selection;
  });
}

function readGlobalSelections(modules, selection = INSTRUCTION_SELECTION) {
  let source;
  try { source = JSON.parse(readFileSync(selection, "utf8")); }
  catch (error) { throw new Error(`instructions/selection.json: ${error.message}`); }
  assertKeys(source, new Set(["mandatory", "repository"]), "instructions/selection.json");
  const mandatory = assertInstructionSelections(source.mandatory, "instructions/selection.json.mandatory", "mandatory", modules);
  const repository = assertInstructionSelections(source.repository, "instructions/selection.json.repository", "repository", modules);
  const declaredMandatory = [...modules.values()].filter((module) => module.layer === "mandatory").map((module) => module.id).sort();
  const selectedMandatory = mandatory.map((selection) => selection.id).sort();
  if (JSON.stringify(declaredMandatory) !== JSON.stringify(selectedMandatory)) {
    throw new Error("instructions/selection.json.mandatory must include every mandatory entry exactly once");
  }
  return { mandatory, repository };
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

function readProfiles(modules, root = PROFILES) {
  const profiles = new Map();
  for (const path of filesUnder(root, ".json")) {
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
    p.instructions = assertInstructionSelections(p.instructions, `${name}.instructions`, "profile", modules);
    if (p.skills === undefined) throw new Error(`${name}.skills: required; use [\"*\"] for all or [] for none`);
    assertStringArray(p.skills, `${name}.skills`);

    const adapters = p.adapters;
    assertKeys(adapters, new Set(["pi", "codex"]), `${name}.adapters`);
    if (adapters.pi === undefined || adapters.codex === undefined) throw new Error(`${name}.adapters: pi and codex are required`);
    assertKeys(adapters.pi, new Set(["tools", "extensions", "mcps", "model"]), `${name}.adapters.pi`);
    for (const key of ["tools", "extensions", "mcps"]) {
      if (adapters.pi[key] !== undefined) assertStringArray(adapters.pi[key], `${name}.adapters.pi.${key}`);
    }
    if (!adapters.pi.extensions?.includes("harness-manager")) {
      throw new Error(`${name}.adapters.pi.extensions: harness-manager is required so the human control plane survives work-profile filtering`);
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

function selectedInstruction(selection, modules) {
  return modules.get(selection.id).variants[selection.detail];
}

function renderAgents(modules, globalSelections) {
  const selections = [...globalSelections.mandatory, ...globalSelections.repository];
  const index = selections.map((selection) => `- \`${selection.id}@${selection.detail}\``).join("\n");
  const body = selections.map((selection) => `<!-- instruction:${selection.id}@${selection.detail} -->\n${selectedInstruction(selection, modules).content}`).join("\n\n");
  return `# AGENTS.md\n\n<!-- GENERATED by harness compose. Edit instructions/, not this file. -->\n\n## 常驻 instruction entries\n\n${index}\n\n${body}\n`;
}

function profileInstructions(profile, modules) {
  return profile.instructions.map((selection) => selectedInstruction(selection, modules).content).join("\n\n");
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

function renderCodex(profile, modules, skillCatalog, catalogRoot = REPO, globalSelections) {
  const lines = [
    "# GENERATED by harness compose. Edit profiles/ or instructions/, not this file.",
  ];
  const model = profile.adapters.codex.model;
  if (model !== undefined) {
    lines.push(`model = ${tomlString(model.id)}`);
    if (model.thinking !== undefined) lines.push(`model_reasoning_effort = ${tomlString(model.thinking)}`);
  }
  const adapter = profile.adapters.codex;
  if (adapter.sandbox !== undefined) lines.push(`sandbox_mode = ${tomlString(adapter.sandbox)}`);
  if (adapter.approval !== undefined) lines.push(`approval_policy = ${tomlString(adapter.approval)}`);
  const core = [...globalSelections.mandatory, ...globalSelections.repository].map((selection) => selectedInstruction(selection, modules).content).join("\n\n");
  const instructions = [core, profileInstructions(profile, modules)].filter(Boolean).join("\n\n");
  if (instructions) lines.push(`developer_instructions = ${tomlString(instructions)}`);

  const selected = resolveSkills(profile.skills, skillCatalog, profile.name);
  if (selected !== undefined) {
    const enabled = new Set(selected);
    for (const skill of skillCatalog) {
      lines.push("", "[[skills.config]]", `path = ${tomlString(catalogRoot.startsWith(`${HOME}/`) ? `~/${relative(HOME, catalogRoot)}/skills/${skill}/SKILL.md` : join(catalogRoot, "skills", skill, "SKILL.md"))}`, `enabled = ${enabled.has(skill)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Compile a Catalog API v1 without installing or executing anything from its tree. */
export function compose({ repo = REPO } = {}) {
  assertCatalog(repo);
  const modules = readModules(join(repo, "instructions"));
  const globalSelections = readGlobalSelections(modules, join(repo, "instructions/selection.json"));
  const profiles = readProfiles(modules, join(repo, "profiles"));
  const state = classify(repo);
  const skillCatalog = [...new Set([...state.declared, ...state.own])].sort();
  const outputs = new Map([
    [join(repo, "AGENTS.md"), renderAgents(modules, globalSelections)],
    [join(repo, "profiles/profile.schema.json"), readFileSync(join(ENGINE, "schemas/profile.schema.json"), "utf8")],
  ]);
  for (const profile of profiles.values()) {
    outputs.set(join(repo, "adapters/pi/profiles", `${profile.name}.json`), renderPi(profile, modules, skillCatalog));
    outputs.set(join(repo, "adapters/codex/profiles", `${profile.name}.config.toml`), renderCodex(profile, modules, skillCatalog, repo, globalSelections));
  }
  return { modules, globalSelections, profiles, skillCatalog, outputs };
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
  const core = [...state.globalSelections.mandatory, ...state.globalSelections.repository].map((selection) => `${selection.id}@${selection.detail}`);
  const reports = names.map((name) => {
    const p = state.profiles.get(name);
    return {
      name,
      label: p.label,
      description: p.description,
      coreInstructions: core,
      profileInstructions: p.instructions.map((selection) => `${selection.id}@${selection.detail}`),
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
    for (const { path, action } of changes) {
      if (action === "remove") continue;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, state.outputs.get(path));
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args[0] === "inspect") {
    try { inspect(args.find((arg, index) => index > 0 && !arg.startsWith("-")), { json: args.includes("--json") }); }
    catch (error) { console.error(`inspect: FAILED - ${error.message}`); process.exitCode = 1; }
  } else {
    process.exitCode = run({ apply: args.includes("--apply"), json: args.includes("--json") });
  }
}
