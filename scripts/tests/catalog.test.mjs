import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compose } from "../compose.mjs";
import { createWebFixture } from "./web-fixture.mjs";
import { settingsMatch } from "../bootstrap.mjs";
import { findStaleManagedLinks, REPO } from "../lib/repo.mjs";
import {
	acquireCatalogLock,
	atomicWrite,
	modelSelectionPool,
	releaseCatalogLock,
	setInstructionSelection,
	summarizeSkillDescription,
} from "../../adapters/pi/extensions/harness-manager-state.mjs";
import { buildAgentToolArgs, getParentActiveTools, resolveAgentTools } from "../../adapters/pi/extensions/subagent/tool-policy.mjs";

test("local settings formatting and key order are not engineering drift", () => {
	const desired = { defaultModel: "personal-model", enabledModels: ["provider/scoped"], packages: ["npm:declared"], skills: [] };
	const reordered = { skills: [], packages: ["npm:declared"], enabledModels: ["provider/scoped"], defaultModel: "personal-model" };
	assert.equal(settingsMatch(JSON.stringify(reordered, null, "\t"), desired), true);
	assert.equal(settingsMatch(JSON.stringify({ ...reordered, packages: ["npm:drift"] }), desired), false);
	assert.equal(settingsMatch("invalid JSON", desired), false);
});

test("instruction catalog has complete three-level entries", () => {
	const root = createWebFixture();
	let state;
	try { state = compose({ repo: root }); } finally { rmSync(root, { recursive: true, force: true }); }
	const required = ["mandatory/00-safety", "repository/00-purpose", "profile/implementation", "profile/strategic"];
	for (const id of required) assert.ok(state.modules.has(id), `missing instruction entry ${id}`);
	for (const entry of state.modules.values()) {
		assert.equal(entry.id.split("/").length, 2, `${entry.id} is not manageable by the flat TUI catalog`);
		assert.deepEqual(Object.keys(entry.variants).sort(), ["brief", "detailed", "standard"]);
		for (const variant of Object.values(entry.variants)) assert.ok(variant.content.length > 0);
	}
	assert.deepEqual(
		state.globalSelections.mandatory.map((selection) => selection.id),
		["mandatory/00-safety"],
	);
});

test("every editable Profile compiles its declared label, model, and ordered instructions", () => {
	const root = createWebFixture();
	let state;
	try { state = compose({ repo: root }); } finally { rmSync(root, { recursive: true, force: true }); }
	assert.ok(state.profiles.size > 0);
	for (const profile of state.profiles.values()) {
		const generated = JSON.parse(state.outputs.get(join(root, "adapters/pi/profiles", `${profile.name}.json`)));
		assert.equal(generated.label, profile.label);
		assert.equal(generated.defaultModel, profile.adapters.pi.model?.id);
		assert.equal(generated.defaultProvider, profile.adapters.pi.model?.provider);
		const text = profile.instructions.map(({ id, detail }) => state.modules.get(id).variants[detail].content).join("\n\n");
		assert.equal(generated.instructions ?? "", text);
		assert.ok(generated.extensions.includes("harness-manager"));
	}
});

test("removed generated profiles leave detectable stale projections", () => {
	const root = mkdtempSync(join(tmpdir(), "harness-projections-"));
	try {
		const sourceRoot = join(root, "repo-profiles");
		const targetRoot = join(root, "native-profiles");
		mkdirSync(sourceRoot);
		mkdirSync(targetRoot);
		writeFileSync(join(sourceRoot, "medium.config.toml"), "# current\n");
		symlinkSync(join(sourceRoot, "medium.config.toml"), join(targetRoot, "medium.config.toml"));
		symlinkSync(join(sourceRoot, "ask.config.toml"), join(targetRoot, "ask.config.toml"));
		assert.deepEqual(findStaleManagedLinks(targetRoot, sourceRoot, ".config.toml"), [join(targetRoot, "ask.config.toml")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("catalog lock serializes managers and atomic writes replace complete files", () => {
	const root = mkdtempSync(join(tmpdir(), "harness-lock-"));
	const source = join(root, "profile.json");
	writeFileSync(source, "before\n");
	const lock = acquireCatalogLock(source);
	try {
		assert.throws(() => acquireCatalogLock(source), (error) => error?.code === "ELOCKED");
		atomicWrite(source, "after\n", "test", "before\n");
		assert.equal(readFileSync(source, "utf8"), "after\n");
		assert.equal(existsSync(`${source}.tmp-test`), false);
		assert.throws(() => atomicWrite(source, "lost\n", "conflict", "stale\n"), (error) => error?.code === "ECHANGED");
		assert.equal(readFileSync(source, "utf8"), "after\n");
	} finally {
		releaseCatalogLock(lock);
		rmSync(root, { recursive: true, force: true });
	}
});

test("instruction selection supports enable, level change, and disable", () => {
	const selections = [{ id: "profile/implementation", detail: "standard" }];
	setInstructionSelection(selections, "profile/implementation", "detailed");
	assert.deepEqual(selections, [{ id: "profile/implementation", detail: "detailed" }]);
	setInstructionSelection(selections, "profile/strategic", "brief");
	assert.deepEqual(selections[1], { id: "profile/strategic", detail: "brief" });
	setInstructionSelection(selections, "profile/implementation", undefined);
	assert.deepEqual(selections, [{ id: "profile/strategic", detail: "brief" }]);
});

test("skill summaries stay bounded for narrow terminals", () => {
	assert.equal(summarizeSkillDescription("  short\n description  "), "short description");
	assert.equal(summarizeSkillDescription("abcdefghij", 6), "abcde…");
	assert.equal(summarizeSkillDescription("中文中文中文", 7), "中文中…");
	const long = summarizeSkillDescription("A".repeat(1000));
	assert.equal(long, `${"A".repeat(111)}…`);
});

test("model picker prefers and deduplicates the current Pi scope", () => {
	const scoped = [
		{ model: { provider: "openai-codex", id: "gpt-scoped" } },
		{ model: { provider: "openai-codex", id: "gpt-scoped" } },
	];
	const available = [{ provider: "deepseek", id: "deepseek-flash" }];
	assert.deepEqual(modelSelectionPool(scoped, available), [{ provider: "openai-codex", id: "gpt-scoped" }]);
	assert.deepEqual(modelSelectionPool([], available), available);

	const source = readFileSync(new URL("../../adapters/pi/extensions/harness-manager.ts", import.meta.url), "utf8");
	assert.match(source, /modelSelectionPool\(ctx\.scopedModels, ctx\.modelRegistry\.getAvailable\(\)\)/);
	assert.match(source, /selectSearchable\(ctx, `选择 Pi model/);
	assert.match(source, /getSupportedThinkingLevels\(selected\)/);
});

test("subagent invocation enforces the parent active tool set", () => {
	const pi = { getActiveTools: () => ["read", "edit", "subagent"] };
	assert.deepEqual(getParentActiveTools(pi), ["read", "edit", "subagent"]);
	assert.deepEqual(resolveAgentTools(["read", "subagent"], ["read", "bash"]), ["read"]);
	assert.deepEqual(buildAgentToolArgs(["subagent"], ["bash"]), ["--no-tools"]);
	assert.deepEqual(buildAgentToolArgs(getParentActiveTools(pi), undefined), ["--tools", "read,edit"]);

	const source = readFileSync(new URL("../../adapters/pi/extensions/subagent/index.ts", import.meta.url), "utf8");
	assert.match(source, /activeTools: getParentActiveTools\(pi\)/);
	assert.match(source, /args\.push\(\.\.\.buildAgentToolArgs\(dispatchDefaults\.activeTools, agent\.tools\)\)/);
});
