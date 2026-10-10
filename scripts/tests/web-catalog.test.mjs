import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyCatalogJson as saveJson, applyCatalogMarkdown as saveMarkdown, createCatalogProfile as createProfile, deleteCatalogProfile as deleteProfile, runCatalogDoctor as doctor } from "../lib/catalog-transaction.mjs";
const applyCatalogJson = (options) => saveJson({ engine: options.repo, ...options });
const applyCatalogMarkdown = (options) => saveMarkdown({ engine: options.repo, ...options });
const createCatalogProfile = (options) => createProfile({ engine: options.repo, ...options });
const deleteCatalogProfile = (options) => deleteProfile({ engine: options.repo, ...options });
const runCatalogDoctor = (root) => doctor(root, root);
import { hashText, parsePiModelList, parsePiPackageList, parseSkillDescription, readCatalog } from "../lib/web-catalog.mjs";
import { parsePiResourceProbe, startHarnessWeb } from "../web.mjs";
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
		assert.equal(catalog.piExtensionDetails.find((entry) => entry.name === "harness-manager").required, true);
		assert.equal(catalog.piExtensionDetails.find((entry) => entry.name === "harness-manager").available, true);
		assert.equal(catalog.modelScope, "session");
		assert.equal(catalog.models.length, 1, "declared models must not escape session scope");
		assert.equal(catalog.models.find((model) => model.id === "gpt-medium").scopeThinking, "medium");
		assert.ok(catalog.profiles.every((profile) => /^[a-f0-9]{64}$/.test(profile.sourceHash)));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Pi package lists preserve declared paths, deduplicate, and never guess missing installations", () => {
	assert.deepEqual(parsePiPackageList("\u001b[1mUser packages:\u001b[0m\n  npm:@scope/tools@1.2.3 (filtered)\n    /installed/tools\n  npm:missing@1\n\nProject packages:\n  npm:@scope/tools@1.2.3\n    /installed/tools\n  npm:relative\n    relative/path\n"), [
		{ source: "npm:@scope/tools@1.2.3", path: "/installed/tools" },
		{ source: "npm:missing@1" }, { source: "npm:relative" },
	]);
	assert.deepEqual(parsePiPackageList("No packages installed.\n"), []);
});

function fixturePackage(root, directory, manifest) {
	const path = join(root, "packages", directory);
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "package.json"), JSON.stringify(manifest));
	return path;
}

function declarePiResources(root, extensions, tools) {
	const path = join(root, "profiles/medium.json");
	const value = JSON.parse(readFileSync(path, "utf8"));
	value.adapters.pi.extensions = ["harness-manager", ...extensions];
	value.adapters.pi.tools = tools;
	writeFileSync(path, JSON.stringify(value));
}

async function fetchCatalog(instance) {
	const response = await fetch(`${instance.origin}/api/catalog`, { headers: { cookie: `harness_web_${instance.server.address().port}=${instance.token}` } });
	assert.equal(response.status, 200);
	return response.json();
}

test("Native packages preserve exact selectable scoped names and stay visible without enabled Profiles", () => {
	const root = createWebFixture();
	try {
		const privateData = "PRIVATE-MANIFEST-DATA";
		const path = fixturePackage(root, "scoped", { name: "@scope/unused", description: "An installed event-only extension", version: "1.2.3", pi: { extensions: ["index.ts"], privateData }, scripts: { secret: privateData }, auth: privateData });
		writeFileSync(join(path, "index.ts"), "throw new Error('must not execute package code');\n");
		const catalog = readCatalog(root, { engine: root, piResources: { packages: [{ source: "npm:@scope/unused@1.2.3", path }] } });
		assert.ok(catalog.piExtensions.includes("@scope/unused"));
		assert.equal(catalog.piExtensions.includes("unused"), false);
		const extension = catalog.piExtensionDetails.find((entry) => entry.name === "@scope/unused");
		assert.equal(extension.description, "An installed event-only extension");
		assert.equal(extension.source, "npm:@scope/unused@1.2.3");
		assert.equal(extension.version, "1.2.3");
		assert.equal(extension.available, true);
		assert.deepEqual(extension.commands, []);
		assert.deepEqual(extension.tools, []);
		assert.equal(catalog.piExtensionDetails.find((entry) => entry.name === "bookmark").available, true, "event-only Catalog files need no registered tool/command");
		assert.equal(JSON.stringify(catalog).includes(privateData), false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

for (const protocol of ["https", "ssh", "git+ssh"])
test(`Authenticated ${protocol} package sources never escape public JSON, without weakening exact association`, async () => {
	const root = createWebFixture();
	const secrets = ["PRIVATE-URL-USER", "PRIVATE%2DURL%2DPASS", "PRIVATE-URL-PASS", "PRIVATE-URL-QUERY", "PRIVATE-URL-FRAGMENT"];
	const source = `git:${protocol}://${secrets[0]}:${secrets[1]}@example.com/org/pkg.git@v1?token=${secrets[3]}#${secrets[4]}`;
	try {
		const path = fixturePackage(root, "private", { name: "@scope/private", description: `From ${source}`, pi: { extensions: [] } });
		writeFileSync(join(path, "index.ts"), "// Metadata only; never imported.\n");
		const sourceInfo = { path: join(path, "index.ts"), source, origin: "package", scope: "user" };
		const resources = {
			packages: parsePiPackageList(`User packages:\n  ${source}\n    ${path}\n  ${source.replace("pkg.git", "unresolved.git")}\n`),
			tools: [{ name: "private-lookup", description: `From ${source}`, parameters: { type: "object", properties: { id: { type: "string", description: `See ${source}` } } }, sourceInfo }],
			commands: [{ name: "private-command", source: "extension", sourceInfo }],
		};
		const original = structuredClone(resources);
		const instance = await startHarnessWeb({ repo: root, engine: root, models: [], piResources: resources });
		try {
			const catalog = await fetchCatalog(instance);
			for (const secret of secrets) assert.equal(JSON.stringify(catalog).includes(secret), false, `public JSON leaked ${secret}`);
			const extension = catalog.piExtensionDetails.find(entry => entry.name === "@scope/private");
			assert.equal(extension.source, `git:${protocol}://example.com/org/pkg.git@v1`);
			assert.equal(extension.sourceRedacted, true, "display source must not become an installation identity");
			assert.equal(extension.available, true, "exact raw source/path must still match the registered tool");
			assert.deepEqual(extension.tools, ["private-lookup"]);
			assert.deepEqual(extension.commands, ["private-command"]);
			assert.equal(catalog.piTools.find(entry => entry.name === "private-lookup").source.source, extension.source);
		} finally { instance.server.close(); await instance.closed; }
		assert.deepEqual(resources, original, "redaction must not rewrite internal identities");
		const mismatch = readCatalog(root, { engine: root, piResources: { ...resources,
			tools: resources.tools.map(tool => ({ ...tool, sourceInfo: { ...sourceInfo, source: source.replace(secrets[0], "OTHER-USER") } })), commands: [],
		} });
		assert.equal(mismatch.piExtensionDetails.find(entry => entry.name === "@scope/private").available, false, "equal redacted URLs are not proof of equal package identities");
		for (const secret of secrets) assert.equal(JSON.stringify(mismatch).includes(secret), false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Resource union preserves missing declarations and the required manager without pretending tools load extensions", () => {
	const root = createWebFixture();
	try {
		declarePiResources(root, ["missing-extension", "same-as-tool", "installed-tool"], ["missing-tool", "registered"]);
		const catalog = readCatalog(root, { engine: root, piResources: {
			packages: [{ source: "npm:missing-package", path: join(root, "not-installed") }],
			tools: [{ name: "same-as-tool", description: "Actual tool", sourceInfo: { source: "auto", origin: "top-level", path: join(root, "native/installed-tool.ts") } }],
		} });
		for (const name of ["missing-extension", "same-as-tool", "missing-package", "harness-manager"]) {
			assert.ok(catalog.piExtensions.includes(name));
			assert.equal(catalog.piExtensionDetails.find((entry) => entry.name === name).available, false);
		}
		assert.equal(catalog.piExtensionDetails.find((entry) => entry.name === "harness-manager").required, true);
		assert.equal(catalog.piExtensionDetails.find((entry) => entry.name === "installed-tool").available, true);
		assert.equal(catalog.piTools.find((entry) => entry.name === "missing-tool").available, false);
		assert.match(catalog.piTools.find((entry) => entry.name === "missing-tool").description, /未.*发现/);
		assert.equal(catalog.piTools.find((entry) => entry.name === "registered").available, false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Registered tool documentation and source associations are public, distinct from Profile activation", () => {
	const root = createWebFixture();
	try {
		const privateData = "PRIVATE-SOURCE-DATA";
		const path = fixturePackage(root, "tools", { name: "@scope/tools", description: "Package tools", pi: { extensions: ["index.ts"] } });
		writeFileSync(join(path, "index.ts"), "// Fixture resource metadata only.\n");
		const sourceInfo = { path: join(path, "index.ts"), source: "npm:@scope/tools", origin: "package", scope: "user", auth: privateData, baseDir: privateData };
		const catalog = readCatalog(root, { engine: root, piResources: {
			settings: { token: privateData }, auth: privateData,
			packages: [{ source: "npm:@scope/tools", path }],
			tools: [{ name: "lookup", description: "Read a record", parameters: { type: "object", properties: { id: { type: "string", description: "Record identifier", default: privateData, examples: [privateData] } }, required: ["id"], privateData }, sourceInfo, annotations: { readOnlyHint: true }, execute: privateData }],
			commands: [{ name: "lookup-settings", description: "Settings", source: "extension", sourceInfo }, { name: "not-an-extension", source: "prompt", sourceInfo }],
		} });
		const tool = catalog.piTools.find((entry) => entry.name === "lookup");
		assert.equal(tool.description, "Read a record");
		assert.deepEqual(tool.parameters, { type: "object", required: ["id"], properties: { id: { type: "string", description: "Record identifier" } } });
		assert.deepEqual(tool.source, { path: join(path, "index.ts"), source: "npm:@scope/tools", origin: "package", scope: "user" });
		assert.equal(tool.risk, "read-only");
		const extension = catalog.piExtensionDetails.find((entry) => entry.name === "@scope/tools");
		assert.deepEqual(extension.commands, ["lookup-settings"]);
		assert.deepEqual(extension.tools, ["lookup"]);
		assert.equal(JSON.stringify(catalog).includes(privateData), false);
		for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
			const builtin = catalog.piTools.find((entry) => entry.name === name);
			assert.ok(builtin.description && builtin.category && builtin.risk && builtin.parameters.properties);
		}
		assert.equal(catalog.piTools.find((entry) => entry.name === "edit").parameters.properties.edits.items.properties.oldText.type, "string");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Exact duplicate packages are harmless; conflicting sources for one exact package name are unavailable", () => {
	const root = createWebFixture();
	try {
		const path = fixturePackage(root, "first", { name: "@one/shared", pi: { extensions: ["index.ts"] } });
		const duplicate = { source: "npm:@one/shared", path };
		const catalog = readCatalog(root, { engine: root, piResources: { packages: [duplicate, duplicate] } });
		assert.equal(catalog.piExtensionDetails.filter((entry) => entry.name === "@one/shared").length, 1);
		assert.equal(catalog.piExtensionDetails.find((entry) => entry.name === "@one/shared").available, true);
		const second = fixturePackage(root, "second", { name: "@one/shared", pi: { extensions: ["index.ts"] } });
		const conflict = readCatalog(root, { engine: root, piResources: { packages: [duplicate, { source: "npm:@two/shared", path: second }] } });
		assert.equal(conflict.piExtensionDetails.find((entry) => entry.name === "@one/shared").available, false);
		assert.match(conflict.piResourceWarning, /冲突/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Builtin registry commands are not advertised as selectable extensions", () => {
	const root = createWebFixture();
	try {
		const sourceInfo = { path: "builtin:mcp", source: "builtin", origin: "top-level", scope: "temporary" };
		const catalog = readCatalog(root, { engine: root, piResources: {
			tools: [{ name: "tool_search", description: "Find registered tools", sourceInfo: { ...sourceInfo, path: "builtin:tool-search" } }],
			commands: [{ name: "mcp", source: "extension", sourceInfo }],
		} });
		assert.ok(catalog.piTools.some((entry) => entry.name === "tool_search"));
		assert.equal(catalog.piTools.find((entry) => entry.name === "tool_search").category, "Pi 内置");
		assert.equal(catalog.piExtensions.some((name) => name.startsWith("builtin:")), false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Resource probe failure is explicit and does not return raw private diagnostics", () => {
	const root = createWebFixture();
	try {
		const privateData = "PRIVATE-DIAGNOSTIC-DATA";
		for (const result of [{ status: 0, stdout: "not metadata" }, { status: null, error: new Error(privateData), stdout: "", stderr: privateData }]) {
			const resources = parsePiResourceProbe(result);
			assert.ok(resources.warning);
			assert.deepEqual(resources.tools, []);
			const catalog = readCatalog(root, { engine: root, piResources: resources });
			assert.match(catalog.piResourceWarning, /探针失败/);
			assert.equal(JSON.stringify(catalog).includes(privateData), false);
			assert.equal(catalog.piTools.find((entry) => entry.name === "read").available, true);
		}
		const envelope = { type: "harness-web-resources", models: [], tools: [], commands: [] };
		const stdout = JSON.stringify({ type: "extension_ui_request", method: "notify", message: JSON.stringify(envelope) });
		assert.equal(parsePiResourceProbe({ status: 0, stdout }).warning, undefined);
		assert.ok(parsePiResourceProbe({ status: 1, stdout }).warning);
		const restricted = JSON.stringify({ type: "extension_ui_request", method: "notify", message: JSON.stringify({ ...envelope, warning: "tool registry unavailable" }) });
		assert.ok(parsePiResourceProbe({ status: 0, stdout: restricted }).warning);
		const failed = `${stdout}\n${JSON.stringify({ type: "response", success: false, error: privateData })}`;
		assert.ok(parsePiResourceProbe({ status: 0, stdout: failed }).warning);
		assert.equal(JSON.stringify(parsePiResourceProbe({ status: 0, stdout: failed })).includes(privateData), false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Web synthetic model/resource inputs never invoke native Pi or inherit its packages", async () => {
	const root = createWebFixture();
	const oldPath = process.env.PATH;
	try {
		writeFileSync(join(root, "scripts/pi"), `#!/bin/sh\necho invoked >> '${join(root, "pi-calls")}'\nexit 1\n`, { mode: 0o755 });
		process.env.PATH = join(root, "scripts");
		for (const options of [{ models: [] }, { modelOutput: "" }, { piResources: { tools: [{ name: "injected", description: "Synthetic tool" }] } }, { models: [], piResources: { tools: [{ name: "injected", description: "Synthetic tool" }] } }]) {
			const instance = await startHarnessWeb({ repo: root, engine: root, ...options });
			try {
				const catalog = await fetchCatalog(instance);
				assert.deepEqual(catalog.models, []);
				assert.equal(catalog.piExtensionDetails.some((entry) => entry.origin === "package"), false);
				assert.equal(catalog.piTools.some((entry) => entry.name === "injected"), Boolean(options.piResources));
				assert.equal(existsSync(join(root, "pi-calls")), false);
			} finally { instance.server.close(); await instance.closed; }
		}
	} finally { process.env.PATH = oldPath; rmSync(root, { recursive: true, force: true }); }
});

test("Explicit model table input is parsed without native discovery", async () => {
	const root = createWebFixture();
	const instance = await startHarnessWeb({ repo: root, engine: root, modelOutput: MODEL_OUTPUT });
	try {
		const catalog = await fetchCatalog(instance);
		assert.equal(catalog.models.length, 3);
		assert.equal(catalog.models[0].id, "gpt-heavy");
	} finally { instance.server.close(); await instance.closed; rmSync(root, { recursive: true, force: true }); }
});

test("Web caches the combined native probe and preserves safe flags while loading normal extensions", async () => {
	const root = createWebFixture();
	const oldPath = process.env.PATH;
	try {
		const path = fixturePackage(root, "native", { name: "@scope/native", description: "Native event-only package", pi: { extensions: ["index.ts"] } });
		const envelope = { type: "harness-web-resources", models: [{ provider: "fixture", id: "fixture-model", thinkingLevels: ["off"] }], tools: [], commands: [] };
		const event = JSON.stringify({ type: "extension_ui_request", method: "notify", message: JSON.stringify(envelope) });
		writeFileSync(join(root, "scripts/pi"), `#!/bin/sh\necho "$*" >> '${join(root, "pi-calls")}'\ncase "$*" in\n  'list') printf 'User packages:\\n  npm:@scope/native\\n    ${path}\\n' ;;\n  *) printf '%s\\n' '${event}' ;;\nesac\n`, { mode: 0o755 });
		process.env.PATH = join(root, "scripts");
		const instance = await startHarnessWeb({ repo: root, engine: root });
		try {
			for (let index = 0; index < 2; index += 1) {
				const catalog = await fetchCatalog(instance);
				assert.equal(catalog.piExtensionDetails.find((entry) => entry.name === "@scope/native").available, true);
				assert.equal(catalog.models[0].id, "fixture-model");
			}
			const calls = readFileSync(join(root, "pi-calls"), "utf8").trim().split("\n");
			assert.equal(calls.length, 2, "RPC and list run only once per server");
			assert.equal(calls[1], "list", "package subcommand must be first; leading flags turn list into a model prompt");
			for (const flag of ["--offline", "--no-context-files", "--no-skills", "--no-session", "--mode rpc"]) assert.ok(calls[0].includes(flag));
			assert.equal(calls[0].includes("--no-extensions"), false);
			assert.equal(calls[0].includes("--no-tools"), false, "metadata discovery needs registered tools; it sends no prompt and executes none");
		} finally { instance.server.close(); await instance.closed; }
	} finally { process.env.PATH = oldPath; rmSync(root, { recursive: true, force: true }); }
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
