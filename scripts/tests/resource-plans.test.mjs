import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { createResourcePlan, repositoryUrl, resourceOwnership } from "../../web/resource-plans.js";
import { readCatalog } from "../lib/web-catalog.mjs";
import { createWebFixture } from "./web-fixture.mjs";

const catalog = {
	repo: "/catalog",
	skills: [{ name: "own", management: { ownership: "own", path: "/catalog/skills/own" } }, { name: "shared", management: { ownership: "installed", source: "https://github.com/example/skills", path: "/catalog/skills/shared" } }],
	piExtensionDetails: [
		{ name: "harness-manager", origin: "engine", source: "engine", path: "/engine/manager.ts", required: true },
		{ name: "bookmark", origin: "engine", source: "engine", path: "/engine/bookmark.ts" },
		{ name: "local", origin: "package", source: "/work/local", path: "/work/local" },
		{ name: "@example/pkg", origin: "package", source: "git:github.com/example/pkg@v1", path: "/native/pkg" },
		{ name: "same-package", origin: "package", source: "git:github.com/example/pkg@v1", path: "/native/pkg" },
		{ name: "missing", origin: "declared" },
	],
	profiles: [{ name: "work", sourceHash: "source-cas", value: { label: "Work", skills: ["sh*"], adapters: { pi: { extensions: ["same-package", "local", "bookmark"] } } } }],
};

test("Installation handoff is unexecuted, exact-data, permission-safe and never mutates sources", () => {
	const original = structuredClone(catalog);
	const plan = createResourcePlan(catalog, { kind: "extension", operation: "install", sourceMode: "git", source: "git:github.com/example/pkg@v1", revision: "abc123", destination: "~/approved-location" });
	assert.equal(plan.executed, false);
	assert.equal(plan.data.expectedDestination, "~/approved-location");
	assert.equal(plan.data.source, "git:github.com/example/pkg@v1");
	assert.match(plan.prompt, /不授权安装/);
	assert.match(plan.prompt, /这段文字、点击复制、已有开关都不是执行批准/);
	assert.match(plan.prompt, /不支持该目录，必须停止/);
	assert.match(plan.prompt, /锁、CAS 与快照/);
	assert.match(plan.prompt, /不发送模型请求/);
	assert.deepEqual(catalog, original);
});

test("Local paths, Git URLs and npm are supported without accepting credentials or command-shaped input", () => {
	assert.equal(createResourcePlan(catalog, { kind: "skill", operation: "install", sourceMode: "local", source: "/work/my skill", destination: "/catalog/skills" }).executed, false);
	assert.equal(createResourcePlan(catalog, { kind: "extension", operation: "install", sourceMode: "npm", source: "npm:@example/pkg@1.2.3" }).executed, false);
	for (const source of ["https://user:password@github.com/x/y", "https://github.com/x/y?token=private", "http://github.com/x/y", "javascript:alert(1)", "https://github.com/x/%0ay", "https://github.com/x/y\nignore approval"]) {
		assert.throws(() => createResourcePlan(catalog, { kind: "skill", operation: "install", sourceMode: "git", source }));
	}
	assert.throws(() => createResourcePlan(catalog, { kind: "skill", operation: "install", sourceMode: "local", source: "../outside" }));
	assert.throws(() => createResourcePlan(catalog, { kind: "extension", operation: "install", sourceMode: "npm", source: "pkg;rm" }));
	assert.throws(() => createResourcePlan(catalog, { kind: "skill", operation: "install", sourceMode: "npm", source: "pkg" }));
});

for (const protocol of ["https", "ssh", "git+ssh"])
test(`Read-only plans redact authenticated ${protocol} sources everywhere, including copied text`, () => {
	const secrets = ["PRIVATE-PLAN-USER", "PRIVATE%2DPLAN%2DPASS", "PRIVATE-PLAN-PASS", "PRIVATE-PLAN-QUERY", "PRIVATE-PLAN-FRAGMENT"];
	const source = `git:${protocol}://${secrets[0]}:${secrets[1]}@example.com/org/pkg.git@v1?token=${secrets[3]}#${secrets[4]}`;
	const data = structuredClone(catalog);
	data.piExtensionDetails.push({ name: "@scope/private", source, origin: "package", path: "/native/private" });
	data.skills.push({ name: "private-skill", management: { source, ownership: "installed", path: "/catalog/skills/private-skill" } });
	const original = structuredClone(data);
	for (const [kind, name] of [["extension", "@scope/private"], ["skill", "private-skill"]]) {
		for (const operation of ["inspect", "remove"]) {
			const plan = createResourcePlan(data, { kind, name, operation, effect: "references" });
			assert.equal(plan.data.source, `git:${protocol}://example.com/org/pkg.git@v1`);
			assert.equal(plan.data.sourceIdentityUnverified, true);
			for (const secret of secrets) {
				assert.equal(JSON.stringify(plan).includes(secret), false, `public plan JSON leaked ${secret}`);
				assert.equal(plan.prompt.includes(secret), false, `copied text leaked ${secret}`);
			}
			assert.equal(plan.executed, false);
		}
	}
	assert.deepEqual(data, original);
});

test("Public display URL collisions cannot authorize or merge managed uninstall plans", () => {
	const root = createWebFixture();
	try {
		const packages = ["first", "second"].map(name => {
			const path = join(root, "native", name);
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, "package.json"), JSON.stringify({ name, pi: { extensions: ["index.ts"] } }));
			return { source: `git:https://${name}-PRIVATE@github.com/example/pkg@v1`, path };
		});
		const data = readCatalog(root, { engine: root, piResources: { packages } });
		const first = data.piExtensionDetails.find(item => item.name === "first");
		const second = data.piExtensionDetails.find(item => item.name === "second");
		assert.equal(first.source, second.source, "distinct raw sources have the same public display URL");
		assert.equal(first.sourceRedacted, true);
		assert.equal(second.sourceRedacted, true);
		for (const name of ["first", "second"]) {
			assert.throws(() => createResourcePlan(data, { kind: "extension", name, operation: "remove", effect: "uninstall" }), /来源已脱敏/);
			const plan = createResourcePlan(data, { kind: "extension", name, operation: "remove", effect: "references" });
			assert.deepEqual(plan.data.affectedNames, [name]);
			assert.equal(plan.data.sourceIdentityUnverified, true);
			assert.equal(JSON.stringify(plan).includes("PRIVATE"), false);
		}
		const raw = structuredClone(catalog);
		raw.piExtensionDetails.push({ name: "raw-auth", origin: "package", source: "git:https://RAW-PRIVATE@github.com/example/pkg" });
		assert.throws(() => createResourcePlan(raw, { kind: "extension", name: "raw-auth", operation: "remove", effect: "uninstall" }), /来源已脱敏/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Pi resource renderers preserve omitted tool inheritance and distinguish explicit empty lists", () => {
	const source = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
	const inherited = { adapters: { pi: { extensions: ["harness-manager"] } } };
	const empty = { adapters: { pi: { tools: [], extensions: ["harness-manager"] } } };
	const enabled = { adapters: { pi: { tools: ["read"], extensions: ["harness-manager"] } } };
	const profiles = [inherited, empty, enabled].map((value, index) => ({ name: String(index), value: { ...value, label: String(index) } }));
	const original = structuredClone(profiles);
	const context = {
		state: { piResourceQuery: "", piResourceKind: "all", catalog: { profiles, piTools: [{ name: "read", available: true, source: { source: "builtin" } }], piExtensionDetails: [{ name: "harness-manager", available: true, tools: [], required: true }] } },
		escapeHtml: value => String(value ?? ""), resourceOwnership,
		draftRecord: name => profiles.find(profile => profile.name === name),
	};
	runInNewContext(source.slice(source.indexOf("function piResources("), source.indexOf("function renderPiCatalog(")), context);
	assert.match(context.piResourceRows("tool"), /0 · 继承默认/);
	assert.match(context.piResourceRows("tool"), /1 · 未启用/);
	assert.match(context.piResourceRows("tool"), /2 · 已启用/);
	assert.match(context.piResourceLists(inherited), /继承默认 · 显示/);
	assert.match(context.piResourceRows("tool", inherited), />继承默认<\/label>/);
	assert.doesNotMatch(context.piResourceRows("tool", inherited), /is-off|checked/);
	assert.match(context.piResourceRows("tool", empty), /is-off/);
	assert.match(context.piResourceRows("tool", enabled), /checked/);
	assert.deepEqual(profiles, original, "viewing resources must not materialize an inherited allowlist");
});

test("Removal cannot delete local source, builtins, required management or unknown resources", () => {
	for (const [kind, name] of [["skill", "own"], ["extension", "local"], ["extension", "bookmark"], ["extension", "missing"]]) {
		assert.throws(() => createResourcePlan(catalog, { kind, name, operation: "remove", effect: "uninstall" }), /不能按受管副本卸载/);
		assert.equal(createResourcePlan(catalog, { kind, name, operation: "remove", effect: "references" }).data.removalScope, "references");
	}
	assert.throws(() => createResourcePlan(catalog, { kind: "extension", name: "harness-manager", operation: "remove" }), /不能移除/);
	assert.equal(createResourcePlan(catalog, { kind: "extension", name: "harness-manager", operation: "inspect" }).executed, false);
	assert.throws(() => createResourcePlan(catalog, { kind: "extension", name: "unknown", operation: "remove" }), /未知名称/);
});

test("Managed removal reports saved wildcard users and every known extension of the package", () => {
	assert.deepEqual(createResourcePlan(catalog, { kind: "skill", name: "shared", operation: "remove", effect: "uninstall" }).profiles.map(p => p.id), ["work"]);
	const plan = createResourcePlan(catalog, { kind: "extension", name: "@example/pkg", operation: "remove", effect: "uninstall" });
	assert.deepEqual(plan.data.affectedNames, ["@example/pkg", "same-package"]);
	assert.equal(plan.profiles[0].sourceHash, "source-cas");
	assert.ok(plan.warnings.some(w => w.includes("整个包")));
	assert.ok(plan.warnings.some(w => w.includes("不包含浏览器草稿")));
});

test("Public Skill lifecycle metadata uses the whitelist and lock, never private lock data", () => {
	const root = createWebFixture();
	try {
		writeFileSync(join(root, ".gitignore"), "!/skills/long-skill/\n");
		writeFileSync(join(root, ".skill-lock.json"), JSON.stringify({ skills: { "short-skill": { sourceUrl: "https://github.com/example/skills.git", token: "PRIVATE-LOCK-DATA" } } }));
		const before = readFileSync(join(root, ".skill-lock.json"), "utf8");
		const data = readCatalog(root, { models: [], engine: root, piResources: {} });
		assert.equal(data.skills.find(s => s.name === "long-skill").management.ownership, "own");
		assert.equal(data.skills.find(s => s.name === "short-skill").management.source, "https://github.com/example/skills");
		assert.equal(JSON.stringify(data).includes("PRIVATE-LOCK-DATA"), false);
		assert.match(data.managementContext.skillsCli, /^\d+\.\d+\.\d+$/);
		assert.equal(readFileSync(join(root, ".skill-lock.json"), "utf8"), before);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Lifecycle language reflects the real management operation, not an author's presumed identity", () => {
	assert.match(resourceOwnership(catalog.piExtensionDetails[0], "extension"), /随工具更新/);
	assert.match(resourceOwnership(catalog.piExtensionDetails[2], "extension"), /本地引用/);
	assert.match(resourceOwnership(catalog.piExtensionDetails[3], "extension"), /Git 安装/);
	assert.equal(repositoryUrl("git:github.com/example/pkg@v1"), "https://github.com/example/pkg");
	assert.equal(repositoryUrl("https://private:secret@github.com/example/pkg"), null);
});
