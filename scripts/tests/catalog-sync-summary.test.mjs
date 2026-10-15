import assert from "node:assert/strict";
import test from "node:test";
import { summarizeCatalogChanges } from "../lib/catalog-sync-summary.mjs";

const encode = tree => Object.fromEntries(Object.entries(tree).map(([path, value]) => [path, typeof value === "string" ? value : JSON.stringify(value)]));
function summarize(before, after, files = [...new Set([...Object.keys(before), ...Object.keys(after)])]) {
	const oldTree = encode(before), newTree = encode(after);
	return summarizeCatalogChanges({ readBefore: path => oldTree[path] ?? null, readAfter: path => newTree[path] ?? null, files });
}
const profile = label => ({ label, description: "Synthetic profile", instructions: [{ id: "profile/test", detail: "brief" }], skills: ["fixture"], adapters: { pi: { model: { provider: "synthetic", id: "model" }, tools: ["read"], extensions: ["harness-manager"] }, codex: { model: { id: "model" } } } });
const skill = overrides => ({ sourceType: "github", source: "fixture/resources", sourceUrl: "https://example.test/fixture/resources.git", skillPath: "skills/fixture/SKILL.md", ref: "main", skillFolderHash: "hash-before", installedAt: "2025-01-01", ...overrides });
const lock = skills => ({ version: 3, skills });
const settings = packages => ({ packages, skills: ["-{{HOME}}/.pi/agent/skills/profile-config/SKILL.md"] });
const entry = (summary, kind, name) => summary.entries.find(value => value.kind === kind && value.name === name);

test("Profiles show human labels and declared model/tools/skills, with additions and removals", () => {
	const old = profile("Before"), next = profile("After");
	next.adapters.pi.model.id = "new-model"; next.adapters.pi.tools.push("write"); next.skills.push("another");
	const result = summarize({ "profiles/main.json": old, "profiles/removed.json": profile("Removed") }, { "profiles/main.json": next, "profiles/new.json": profile("New") });
	assert.equal(entry(result, "profile", "main").label, "After");
	assert.deepEqual(entry(result, "profile", "main").detail, { before: old, after: next });
	assert.equal(entry(result, "profile", "new").operation, "add");
	assert.equal(entry(result, "profile", "removed").operation, "remove");
	assert.deepEqual(result.counts, { total: 3, add: 1, update: 1, remove: 1, documentation: 0 });
	assert.deepEqual(result.installationChanges, []); assert.equal(result.requiresInstallation, false);
});

test("JSON formatting/key order/schema links and installedAt-only lock noise have no semantic changes", () => {
	const value = profile("Fixture");
	assert.deepEqual(summarize({ "profiles/main.json": { ...value, $schema: "old" } }, { "profiles/main.json": { $schema: "new", ...value } }).entries, []);
	const before = { ".skill-lock.json": lock({ fixture: skill() }) };
	const after = { ".skill-lock.json": lock({ fixture: skill({ installedAt: "2030-01-01", lastUpdated: "cosmetic", extra: "ignored" }) }) };
	const result = summarize(before, after);
	assert.deepEqual(result.entries, []); assert.deepEqual(result.installationChanges, []); assert.equal(result.requiresInstallation, false);
	assert.deepEqual(summarize({ "expected-gaps.json": '{"a":1,"b":2}' }, { "expected-gaps.json": '{ "b": 2, "a": 1 }' }).entries, []);
});

test("Third-party lock additions, removals and hash changes produce declaration-only installation items", () => {
	const result = summarize({ ".skill-lock.json": lock({ changed: skill(), removed: skill() }) }, { ".skill-lock.json": lock({ changed: skill({ skillFolderHash: "hash-after" }), added: skill({ ref: "v2" }) }) });
	assert.deepEqual(result.installationChanges.map(({ name, operation }) => [name, operation]), [["added", "add"], ["changed", "update"], ["removed", "remove"]]);
	assert.deepEqual(result.installationChanges[1], { kind: "skill", name: "changed", operation: "update", source: "fixture/resources", previousSource: "fixture/resources", version: "main · hash-after" });
	assert.equal(result.requiresInstallation, true);
	assert.equal(entry(result, "skill", "changed").detail.after.skillFolderHash, "hash-after");
	assert.equal("installedAt" in entry(result, "skill", "changed").detail.after, false);
	assert.equal(JSON.stringify(result).includes("installed"), false);
});

for (const [field, value] of Object.entries({ sourceType: "git", source: "fixture/other", sourceUrl: "https://example.test/other.git", skillPath: "other/SKILL.md", ref: "v2", skillFolderHash: "new-hash", wellKnownDigest: "new-digest", sourceBaseUrl: "https://example.test/resources" })) {
	test(`Skill identity includes ${field}`, () => {
		const result = summarize({ ".skill-lock.json": lock({ fixture: skill() }) }, { ".skill-lock.json": lock({ fixture: skill({ [field]: value }) }) });
		assert.equal(result.installationChanges.length, 1); assert.equal(result.installationChanges[0].operation, "update");
	});
}

test("Well-known lock sources retain digest/version and full identity", () => {
	const spec = { sourceType: "well-known", sourceBaseUrl: "https://example.test", wellKnownDigest: "sha256:fixture" };
	const result = summarize({}, { ".skill-lock.json": lock({ fixture: spec }) });
	assert.deepEqual(entry(result, "skill", "fixture").detail.after, spec);
	assert.equal(result.installationChanges[0].source, spec.sourceBaseUrl); assert.equal(result.installationChanges[0].version, spec.wellKnownDigest);
});

test("npm (including scopes), Git and local Pi packages preserve full specs and compare declared revisions", () => {
	const before = settings(["npm:@fixture/plugin@1.0.0", "git:https://example.test/fixture/plugin.git@v1", "/tmp/local-one", "npm:removed@1"]);
	const after = settings([{ source: "npm:@fixture/plugin@2.0.0", extensions: ["main.ts"], skills: ["!private"] }, "git:https://example.test/fixture/plugin.git@v2", "/tmp/local-two", "npm:added@1"]);
	const result = summarize({ "adapters/pi/settings.json": before }, { "adapters/pi/settings.json": after });
	assert.equal(entry(result, "pi-package", "@fixture/plugin").operation, "update");
	assert.deepEqual(entry(result, "pi-package", "@fixture/plugin").detail.after, after.packages[0]);
	const npm = result.installationChanges.find(value => value.name === "@fixture/plugin");
	assert.deepEqual(npm, { kind: "pi-package", name: "@fixture/plugin", operation: "update", source: "npm:@fixture/plugin@2.0.0", previousSource: "npm:@fixture/plugin@1.0.0", version: "npm:@fixture/plugin@2.0.0" });
	assert.equal(result.installationChanges.find(value => value.name === "git:https://example.test/fixture/plugin.git").operation, "update");
	assert.equal(result.installationChanges.find(value => value.name === "/tmp/local-one").operation, "remove");
	assert.equal(result.installationChanges.find(value => value.name === "/tmp/local-two").operation, "add");
	assert.equal(result.installationChanges.length, 6);
});

test("Git branch names containing slashes are version changes, not unrelated package identities", () => {
	const before = "git:https://example.test/fixture/plugin.git@feature/one", after = "git:https://example.test/fixture/plugin.git@feature/two";
	const result = summarize({ "adapters/pi/settings.json": { packages: [before] } }, { "adapters/pi/settings.json": { packages: [after] } });
	assert.equal(result.entries.length, 1); assert.equal(result.installationChanges.length, 1);
	assert.equal(result.installationChanges[0].operation, "update");
	assert.equal(result.installationChanges[0].name, "git:https://example.test/fixture/plugin.git");
});

test("Package-only settings creation/removal does not invent a separate settings change", () => {
	const added = summarize({}, { "adapters/pi/settings.json": { packages: ["npm:fixture@1"] } });
	const removed = summarize({ "adapters/pi/settings.json": { packages: ["npm:fixture@1"] } }, {});
	assert.equal(added.entries.length, 1); assert.equal(added.entries[0].operation, "add");
	assert.equal(removed.entries.length, 1); assert.equal(removed.entries[0].operation, "remove");
});

test("Lock skill names do not inherit phantom entries from Object.prototype", () => {
	const result = summarize({ ".skill-lock.json": lock({}) }, { ".skill-lock.json": lock({ constructor: skill() }) });
	assert.equal(result.entries[0].operation, "add"); assert.equal(result.installationChanges[0].operation, "add");
	assert.equal(result.installationChanges[0].previousSource, null);
});

test("Pi resource-filter-only changes and string/object conversion are config changes, not downloads", () => {
	const spec = { source: "npm:fixture@1", extensions: ["*.ts"], skills: ["public"], prompts: [], themes: ["light.json"] };
	const after = { ...spec, extensions: ["main.ts"], prompts: ["question.md"] };
	for (const before of [spec, spec.source]) {
		const result = summarize({ "adapters/pi/settings.json": settings([before]) }, { "adapters/pi/settings.json": settings([after]) });
		assert.deepEqual(entry(result, "pi-package", "fixture").detail, { before, after });
		assert.deepEqual(result.installationChanges, []); assert.equal(result.requiresInstallation, false);
	}
});

test("Instructions group all variants by ID; lifecycle reads unchanged canonical variants; generated outputs are excluded", () => {
	const before = { "instructions/profile/test.md": "Standard", "instructions/profile/test.brief.md": "Brief", "instructions/profile/test.detailed.md": "Detailed", "instructions/selection.json": { mandatory: [], repository: [] } };
	const after = { ...before, "instructions/profile/test.brief.md": "New brief", "instructions/profile/test.detailed.md": "New detailed", "instructions/selection.json": { mandatory: [{ id: "mandatory/safety", detail: "standard" }], repository: [] }, "AGENTS.md": "Generated", "profiles/profile.schema.json": "not JSON", "adapters/pi/profiles/main.json": "not JSON", "adapters/codex/profiles/main.toml": "Generated" };
	const result = summarize(before, after);
	assert.equal(result.entries.length, 2);
	assert.deepEqual(entry(result, "instruction", "profile/test").detail, { variants: ["brief", "detailed"] });
	assert.equal(entry(result, "instruction-selection", "global").operation, "update");
	const removedVariant = { ...before }; delete removedVariant["instructions/profile/test.brief.md"];
	assert.equal(summarize(before, removedVariant, ["instructions/profile/test.brief.md"]).entries[0].operation, "update");
	const removed = summarize(before, {}, Object.keys(before));
	assert.equal(entry(removed, "instruction", "profile/test").operation, "remove");
});

test("Own skills and personal Pi resources group by resource name, not raw filenames/content", () => {
	const before = { "skills/own/SKILL.md": "Own skill", "skills/own/helper.mjs": "old", "adapters/pi/extensions/custom/index.ts": "unchanged", "adapters/pi/extensions/custom/helper.ts": "old", "adapters/pi/agents/reviewer.md": "old", "adapters/pi/prompts/check.md": "old" };
	const after = { ...before, "skills/own/helper.mjs": "new", "skills/own/README.md": "More docs", "adapters/pi/extensions/custom/helper.ts": "new", "adapters/pi/extensions/single.ts": "export default () => { throw Error('never execute'); }", "adapters/pi/prompts/check.md": "new" };
	delete after["adapters/pi/agents/reviewer.md"];
	const result = summarize(before, after);
	assert.equal(entry(result, "own-skill", "own").operation, "update");
	assert.equal(entry(result, "pi-extension", "custom").operation, "update");
	assert.equal(entry(result, "pi-extension", "single").operation, "add");
	assert.equal(entry(result, "pi-agent", "reviewer").operation, "remove");
	assert.equal(entry(result, "pi-prompt", "check").operation, "update");
	assert.equal(result.entries.length, 5); assert.deepEqual(result.installationChanges, []);
	assert.equal(JSON.stringify(result).includes("never execute"), false);
});

test("Engineering exclusions/settings are semantic entries and docs only expose a count", () => {
	const result = summarize({ ".gitignore": "/skills/*\n", "expected-gaps.json": { declaredNotInstalled: {} }, "adapters/pi/settings.json": settings([]), "README.md": "Old" }, { ".gitignore": "/skills/*\n!/skills/own/\n", "expected-gaps.json": { declaredNotInstalled: { fixture: "Reason" } }, "adapters/pi/settings.json": { ...settings([]), skills: ["-excluded"] }, "README.md": "SECRET DOCUMENT CONTENT", "profiles/README.md": "Another doc" });
	assert.equal(entry(result, "settings", "resource-exclusions").operation, "update");
	assert.equal(entry(result, "settings", "expected-gaps").operation, "update");
	assert.equal(entry(result, "settings", "pi").operation, "update");
	assert.deepEqual(entry(result, "documentation", "documentation").detail, { count: 2 });
	assert.equal(result.counts.documentation, 2); assert.equal(result.requiresInstallation, false);
	assert.equal(JSON.stringify(result).includes("SECRET DOCUMENT CONTENT"), false);
});

test("Malformed metadata and unsafe entry identifiers fail without exposing supplied values", () => {
	for (const tree of [
		{ ".skill-lock.json": "{bad" }, { ".skill-lock.json": [] }, { ".skill-lock.json": { skills: [] } },
		{ ".skill-lock.json": lock({ fixture: null }) }, { ".skill-lock.json": lock({ "../unsafe": skill() }) },
		{ ".skill-lock.json": lock({ fixture: skill({ skillPath: 42 }) }) }, { ".skill-lock.json": lock({ fixture: skill({ skillPath: "../outside" }) }) },
		{ "profiles/main.json": {} }, { "profiles/unsafe..id.json": profile("Bad") },
		{ "instructions/selection.json": { mandatory: [{ id: "mandatory/../unsafe", detail: "standard" }] } },
		{ "adapters/pi/settings.json": { packages: {} } }, { "adapters/pi/settings.json": settings([{ source: "npm:fixture", extensions: "not-array" }]) },
		{ "adapters/pi/settings.json": settings(["npm:fixture@1", "npm:fixture@2"]) },
		{ "adapters/pi/settings.json": settings(["../outside"]) }, { "adapters/pi/settings.json": settings(["/tmp/../outside"]) },
		{ "adapters/pi/settings.json": settings(["npm:..@1"]) }, { "adapters/pi/settings.json": settings(["npm:@../fixture@1"]) },
		{ "adapters/codex/settings.json": "malformed" },
		{ "adapters/pi/settings.json": { token: "synthetic-sensitive-value" } },
		{ "profiles/main.json": { ...profile("Bad"), adapters: { pi: { tools: "invalid" } } } },
		{ "skills/unsafe..id/SKILL.md": "Bad" }, { "../README.md": "Bad" },
	]) assert.throws(() => summarize({}, tree), /invalid or unsafe/);
	assert.throws(() => summarize({ ".skill-lock.json": "invalid old metadata" }, { ".skill-lock.json": lock({}) }));
});

test("Credential-shaped installation sources are rejected with sanitized diagnostics", () => {
	const token = "gh" + "p_" + "A".repeat(36);
	for (const unsafe of ["https://user:super-secret@example.test/repo.git", "git:https://user:super-secret@example.test/repo.git@v1", "https://example.test/repo?token=super-secret", "https://example.test/repo#secret", `npm:fixture@${token}`, `https://example.test/${encodeURIComponent(token)}`, "https://user%3Asuper-secret%40example.test/repo", "https://example.test/%0aunsafe", "user:super-secret@example.test/repo"]) {
		for (const tree of [{ "adapters/pi/settings.json": settings([unsafe]) }, { ".skill-lock.json": lock({ fixture: skill({ source: unsafe }) }) }]) {
			assert.throws(() => summarize({}, tree), error => !error.message.includes(unsafe) && !error.message.includes(token) && !error.message.includes("super-secret"));
		}
	}
});

test("Only supplied fixed readers are used; callback failures are sanitized; results are deterministic", () => {
	const calls = [], tree = encode({ "profiles/main.json": profile("Fixture"), "AGENTS.md": "Generated", "README.md": "Docs" });
	const result = summarizeCatalogChanges({ readBefore: path => { calls.push(path); return null; }, readAfter: path => { calls.push(path); return tree[path] ?? null; }, files: ["README.md", "profiles/main.json", "AGENTS.md", "profiles/main.json"] });
	assert.deepEqual(calls, ["profiles/main.json", "profiles/main.json"]);
	assert.equal(result.entries.length, 2);
	assert.throws(() => summarizeCatalogChanges({ readBefore: () => { throw new Error("secret-reader-diagnostic"); }, readAfter: () => null, files: ["profiles/main.json"] }), error => !error.message.includes("secret-reader-diagnostic"));
	assert.deepEqual(summarize({}, { "profiles/main.json": profile("Fixture"), "README.md": "Docs" }), result);
});
