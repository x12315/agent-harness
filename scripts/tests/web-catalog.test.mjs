import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyCatalogJson as saveJson, applyCatalogMarkdown as saveMarkdown, createCatalogProfile as createProfile, deleteCatalogProfile as deleteProfile, runCatalogDoctor as doctor } from "../lib/catalog-transaction.mjs";
const applyCatalogJson = (options) => saveJson({ engine: options.repo, ...options });
const applyCatalogMarkdown = (options) => saveMarkdown({ engine: options.repo, ...options });
const createCatalogProfile = (options) => createProfile({ engine: options.repo, ...options });
const deleteCatalogProfile = (options) => deleteProfile({ engine: options.repo, ...options });
const runCatalogDoctor = (root) => doctor(root, root);
import { hashText, parsePiModelList, parseSkillDescription, readCatalog } from "../lib/web-catalog.mjs";
import { createWebFixture, MODEL_OUTPUT } from "./web-fixture.mjs";

test("Skill frontmatter keeps folded long descriptions available", () => {
	assert.equal(parseSkillDescription("---\ndescription: Plain text.\n---\n"), "Plain text.");
	assert.equal(parseSkillDescription("---\ndescription: >-\n  first line\n  second line\nname: fixture\n---\n"), "first line second line");
	assert.equal(parseSkillDescription("# no frontmatter"), "无说明");
});

test("Pi model table becomes a searchable model catalogue", () => {
	assert.deepEqual(parsePiModelList(MODEL_OUTPUT), [
		{ provider: "openai-codex", id: "gpt-heavy", context: "128K", maxOutput: "64K", reasoning: true, images: false, thinkingLevels: null },
		{ provider: "openai-codex", id: "gpt-medium", context: "272K", maxOutput: "128K", reasoning: true, images: true, thinkingLevels: null },
		{ provider: "deepseek", id: "deepseek-x", context: "1M", maxOutput: "128K", reasoning: false, images: false, thinkingLevels: ["off"] },
	]);
});

test("Web catalogue exposes profiles, full Skill descriptions, instructions, and model scope", () => {
	const root = createWebFixture();
	try {
		const catalog = readCatalog(root, {
			modelOutput: MODEL_OUTPUT,
			scopeModels: [{ provider: "openai-codex", id: "gpt-medium", thinking: "medium" }],
		});
		assert.deepEqual(catalog.profiles.map((profile) => profile.name), ["heavy", "medium", "ultralight"]);
		assert.match(catalog.skills.find((skill) => skill.name === "long-skill").description, /Long skill description/);
		assert.equal(catalog.instructions.length, 4);
		assert.ok(catalog.piExtensions.includes("bookmark") && catalog.piExtensions.includes("subagent"), "available extensions must not depend on any Profile enabling them");
		assert.equal(catalog.modelScope, "session");
		assert.equal(catalog.models.length, 1, "declared models must not escape session scope");
		assert.equal(catalog.models.find((model) => model.id === "gpt-medium").scopeThinking, "medium");
		assert.ok(catalog.profiles.every((profile) => /^[a-f0-9]{64}$/.test(profile.sourceHash)));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Web save transaction applies, verifies, and detects concurrent edits", () => {
	const root = createWebFixture();
	try {
		const source = join(root, "profiles/medium.json");
		const original = readFileSync(source, "utf8");
		const profile = JSON.parse(original);
		profile.description = "Changed through Harness Web";
		const applied = applyCatalogJson({ repo: root, source, expectedHash: hashText(original), value: profile });
		assert.equal(applied.ok, true, JSON.stringify(applied));
		assert.match(readFileSync(source, "utf8"), /Changed through Harness Web/);
		assert.deepEqual(readFileSync(join(root, "calls.log"), "utf8").trim().split("\n"), ["compose --apply", "verify --catalog"]);
		assert.equal(existsSync(`${source}.harness.lock`), false);

		const current = readFileSync(source, "utf8");
		const external = JSON.parse(current);
		external.description = "External change";
		writeFileSync(source, `${JSON.stringify(external, null, 2)}\n`);
		const conflict = applyCatalogJson({ repo: root, source, expectedHash: hashText(current), value: profile });
		assert.equal(conflict.status, 409);
		assert.match(readFileSync(source, "utf8"), /External change/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Runtime failure and rollback verify only the affected adapter and Profile", () => {
	const root = createWebFixture();
	try {
		const source = join(root, "profiles/medium.json");
		const original = readFileSync(source, "utf8");
		const value = JSON.parse(original);
		value.adapters.pi.model.thinking = "high";
		writeFileSync(join(root, "fail-once"), "verify --runtime=pi --profile=medium");
		const result = applyCatalogJson({ repo: root, source, expectedHash: hashText(original), value });
		assert.equal(result.status, 422, JSON.stringify(result));
		assert.equal(result.rollbackVerified, true);
		assert.equal(readFileSync(source, "utf8"), original);
		assert.deepEqual(readFileSync(join(root, "calls.log"), "utf8").trim().split("\n"), [
			"compose --apply", "verify --catalog", "verify --runtime=pi --profile=medium",
			"compose --apply", "verify --catalog", "verify --runtime=pi --profile=medium",
		]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Saving an unchanged source runs no verification or writes", () => {
	const root = createWebFixture();
	try {
		const source = join(root, "profiles/medium.json");
		const original = readFileSync(source, "utf8");
		const result = applyCatalogJson({ repo: root, source, expectedHash: hashText(original), value: JSON.parse(original) });
		assert.equal(result.ok, true);
		assert.equal(result.validation.kind, "unchanged");
		assert.deepEqual(result.logs, []);
		assert.equal(existsSync(join(root, "calls.log")), false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Web save transaction restores the original source after validation failure", () => {
	const root = createWebFixture();
	try {
		const source = join(root, "profiles/medium.json");
		const original = readFileSync(source, "utf8");
		const profile = JSON.parse(original);
		profile.description = "Must be rolled back";
		writeFileSync(join(root, "fail-compose"), "fail\n");
		const result = applyCatalogJson({ repo: root, source, expectedHash: hashText(original), value: profile });
		assert.equal(result.ok, false);
		assert.equal(result.status, 422);
		assert.equal(readFileSync(source, "utf8"), original);
		assert.ok(result.backup && existsSync(result.backup));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Web rollback stops rather than overwriting an external writer", () => {
	const root = createWebFixture();
	try {
		const source = join(root, "profiles/medium.json");
		const original = readFileSync(source, "utf8");
		const profile = JSON.parse(original);
		profile.description = "manager draft";
		writeFileSync(join(root, "change-on-compose"), "change\n");
		writeFileSync(join(root, "fail-compose"), "fail\n");
		const result = applyCatalogJson({ repo: root, source, expectedHash: hashText(original), value: profile });
		assert.equal(result.status, 409);
		assert.match(readFileSync(source, "utf8"), /external writer/);
		assert.ok(result.backup && existsSync(result.backup));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Web Catalog writes reject source symlinks", () => {
	const root = createWebFixture();
	try {
		const target = join(root, "profiles/medium.json");
		const source = join(root, "profiles/link.json");
		symlinkSync(target, source);
		const original = readFileSync(target, "utf8");
		const result = applyCatalogJson({ repo: root, source, expectedHash: hashText(original), value: JSON.parse(original) });
		assert.equal(result.status, 400);
		assert.equal(readFileSync(target, "utf8"), original);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Web Catalog writes reject symlinked parent directories", () => {
	const root = createWebFixture();
	try {
		const source = join(root, "profiles/medium.json");
		const original = readFileSync(source, "utf8");
		renameSync(join(root, "profiles"), join(root, "redirected"));
		symlinkSync(join(root, "redirected"), join(root, "profiles"), "dir");
		const result = applyCatalogJson({ repo: root, source, expectedHash: hashText(original), value: JSON.parse(original) });
		assert.equal(result.status, 400);
		assert.equal(readFileSync(source, "utf8"), original);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Web uses real model thinking metadata instead of generic guesses", () => {
	const root = createWebFixture();
	try {
		const metadata = { provider: "deepseek", id: "deepseek-x", thinkingLevels: ["off", "low", "high", "max"] };
		const catalog = readCatalog(root, { models: [metadata], scopeModels: [{ provider: "deepseek", id: "deepseek-x" }] });
		assert.deepEqual(catalog.models[0].thinkingLevels, metadata.thinkingLevels);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Web rejects credential-shaped content before writing or logging it", () => {
	const root = createWebFixture();
	try {
		const source = join(root, "instructions/profile/implementation.md");
		const original = readFileSync(source, "utf8");
		const fakeCredential = "sk-" + "A".repeat(40);
		const result = applyCatalogMarkdown({ repo: root, source, expectedHash: hashText(original), value: `## Fixture\n\n${fakeCredential}\n` });
		assert.equal(result.status, 400);
		assert.equal(readFileSync(source, "utf8"), original);
		assert.equal(existsSync(join(root, "calls.log")), false);
		assert.equal(JSON.stringify(result).includes(fakeCredential), false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Profile creation and deletion compile both adapters, snapshot, and enforce source CAS", () => {
	const root = createWebFixture();
	try {
		const value = JSON.parse(readFileSync(join(root, "profiles/medium.json")));
		const source = join(root, "profiles/Custom.1.json");
		const created = createCatalogProfile({ repo: root, name: "Custom.1", value });
		assert.equal(created.status, 201, JSON.stringify(created));
		assert.ok(existsSync(join(root, "adapters/pi/profiles/Custom.1.json")));
		assert.ok(existsSync(join(root, "adapters/codex/profiles/Custom.1.config.toml")));
		assert.equal(createCatalogProfile({ repo: root, name: "custom.1", value }).status, 409);
		assert.equal(deleteCatalogProfile({ repo: root, name: "Custom.1", expectedHash: "a".repeat(64) }).status, 409);
		const original = readFileSync(source, "utf8");
		const removed = deleteCatalogProfile({ repo: root, name: "Custom.1", expectedHash: hashText(original) });
		assert.equal(removed.ok, true, JSON.stringify(removed));
		assert.equal(readFileSync(removed.backup, "utf8"), original);
		assert.equal(existsSync(source), false);
		assert.equal(existsSync(join(root, "adapters/pi/profiles/Custom.1.json")), false);
		assert.equal(existsSync(join(root, "adapters/codex/profiles/Custom.1.config.toml")), false);
		assert.equal(existsSync(`${source}.harness.lock`), false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Profile lifecycle rejects unsafe IDs, symlinks, secrets, and deleting the last Profile", () => {
	const root = createWebFixture();
	try {
		const original = readFileSync(join(root, "profiles/medium.json"), "utf8");
		const value = JSON.parse(original);
		for (const name of ["../escape", "default", "Default", "profile.schema", "", null]) {
			assert.equal(createCatalogProfile({ repo: root, name, value }).status, 400);
			assert.equal(deleteCatalogProfile({ repo: root, name, expectedHash: hashText(original) }).status, 400);
		}
		assert.equal(createCatalogProfile({ repo: root, name: "secret", value: { ...value, description: "sk-" + "A".repeat(40) } }).status, 400);
		assert.equal(existsSync(join(root, "profiles/secret.json")), false);
		symlinkSync(join(root, "profiles/medium.json"), join(root, "profiles/link.json"));
		assert.equal(createCatalogProfile({ repo: root, name: "link", value }).status, 400);
		assert.equal(deleteCatalogProfile({ repo: root, name: "link", expectedHash: hashText(original) }).status, 400);
		rmSync(join(root, "profiles/link.json"));
		for (const name of ["heavy", "ultralight"]) {
			const expectedHash = hashText(readFileSync(join(root, `profiles/${name}.json`), "utf8"));
			assert.equal(deleteCatalogProfile({ repo: root, name, expectedHash }).ok, true);
		}
		assert.equal(deleteCatalogProfile({ repo: root, name: "medium", expectedHash: hashText(original) }).status, 400);
		renameSync(join(root, "profiles"), join(root, "redirected"));
		symlinkSync(join(root, "redirected"), join(root, "profiles"), "dir");
		assert.equal(createCatalogProfile({ repo: root, name: "new", value }).status, 400);
		assert.equal(existsSync(join(root, "redirected/new.json.harness.lock")), false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Profile lifecycle rolls back sources and generated files after late validation failures", () => {
	const root = createWebFixture();
	try {
		const original = readFileSync(join(root, "profiles/medium.json"), "utf8");
		const value = JSON.parse(original);
		writeFileSync(join(root, "fail-once"), "verify --catalog");
		const created = createCatalogProfile({ repo: root, name: "new", value });
		assert.equal(created.status, 422, JSON.stringify(created));
		assert.equal(created.rollbackVerified, true);
		assert.equal(existsSync(join(root, "profiles/new.json")), false);
		assert.equal(existsSync(join(root, "adapters/pi/profiles/new.json")), false);
		writeFileSync(join(root, "fail-once"), "verify --catalog");
		const deleted = deleteCatalogProfile({ repo: root, name: "medium", expectedHash: hashText(original) });
		assert.equal(deleted.status, 422, JSON.stringify(deleted));
		assert.equal(deleted.rollbackVerified, true);
		assert.equal(readFileSync(join(root, "profiles/medium.json"), "utf8"), original);
		assert.ok(existsSync(join(root, "adapters/pi/profiles/medium.json")));
		assert.ok(existsSync(join(root, "adapters/codex/profiles/medium.config.toml")));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Profile lifecycle never overwrites an external writer during rollback", () => {
	const root = createWebFixture();
	try {
		const original = readFileSync(join(root, "profiles/medium.json"), "utf8");
		const value = JSON.parse(original);
		writeFileSync(join(root, "fail-compose"), "fail");
		for (const operation of ["create", "delete"]) {
			const name = operation === "create" ? "new" : "medium";
			writeFileSync(join(root, "write-on-compose"), JSON.stringify({ name, value: { ...value, label: "external writer" } }));
			const result = operation === "create" ? createCatalogProfile({ repo: root, name, value })
				: deleteCatalogProfile({ repo: root, name, expectedHash: hashText(original) });
			assert.equal(result.status, 409, JSON.stringify(result));
			assert.match(readFileSync(join(root, `profiles/${name}.json`), "utf8"), /external writer/);
			assert.ok(existsSync(result.backup));
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Web doctor delegates to the same Harness verification path", () => {
	const root = createWebFixture();
	try {
		const result = runCatalogDoctor(root);
		assert.equal(result.ok, true);
		assert.match(result.output, /fixture doctor: OK/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
