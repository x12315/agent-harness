import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE } from "../lib/repo.mjs";
import { runCatalogSync } from "../lib/catalog-sync.mjs";
import { createCatalogSyncFixture } from "./web-fixture.mjs";

function fixture(callback) {
	const data = createCatalogSyncFixture();
	const invoke = options => runCatalogSync({ repo: data.repo, home: data.home, engine: ENGINE, ...options });
	const register = () => { const status = invoke({}); return invoke({ operation: "register", remote: "origin", branch: "main", automaticCheck: false, expectedHash: status.registrationHash }); };
	const review = () => invoke({ operation: "check", force: true });
	const sync = (value, extra = {}) => invoke({ operation: "sync", expectedHash: value.registrationHash, expectedHead: value.head, expectedCommit: value.commit, ...extra });
	const updateFile = (path, content) => { mkdirSync(join(data.source, path, ".."), { recursive: true }); writeFileSync(join(data.source, path), content); data.git(data.source, "add", path); data.git(data.source, "commit", "-m", "fixture: declarative update"); };
	try { return callback({ ...data, invoke, register, review, sync, updateFile }); }
	finally { data.restoreEnvironment(); rmSync(data.root, { recursive: true, force: true }); }
}

const nativeSettings = home => join(home, ".pi/agent/settings.json");
function writeSettings(home, content) { mkdirSync(join(home, ".pi/agent"), { recursive: true }); writeFileSync(nativeSettings(home), content, { mode: 0o600 }); }

test("One approved sync generates, projects and statically verifies; personal settings/auth stay native", () => fixture(({ repo, home, git, register, review, sync, update }) => {
	writeSettings(home, JSON.stringify({ packages: [], skills: [], theme: "fixture-dark", defaultModel: "local-choice", editorPaddingX: 2 }));
	const auth = join(home, ".pi/agent/auth.json"), authBytes = '{"synthetic":"native-auth-fixture-only"}\n'; writeFileSync(auth, authBytes, { mode: 0o600 });
	register(); update("Configuration documentation update.\n"); const value = review();
	assert.equal(value.summary.entries[0].kind, "documentation");
	const result = sync(value); assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.synced, true); assert.equal(result.configurationApplied, true); assert.equal(result.needsApply, false); assert.equal(result.needsReload, true);
	assert.deepEqual(result.phases.map(phase => [phase.name, phase.status]), [["generate", "done"], ["project", "done"], ["verify", "done"]]);
	assert.deepEqual(result.validation, { kind: "catalog-static", full: false });
	assert.equal(git(repo, "rev-parse", "HEAD"), value.commit);
	assert.equal(readFileSync(auth, "utf8"), authBytes);
	assert.equal(JSON.parse(readFileSync(nativeSettings(home))).theme, "fixture-dark");
	assert.equal(JSON.parse(readFileSync(nativeSettings(home))).defaultModel, "local-choice");
	assert.equal(statSync(nativeSettings(home)).mode & 0o777, 0o600);
	const snapshot = readFileSync(result.configurationBackup, "utf8"); assert.equal(statSync(result.configurationBackup).mode & 0o777, 0o600);
	assert.equal(snapshot.includes("native-auth-fixture-only"), false); assert.equal(snapshot.includes(Buffer.from(authBytes).toString("base64")), false);
	assert.equal(snapshot.includes(auth), false); assert.equal(snapshot.includes("auth.json"), false);
	assert.equal(JSON.parse(snapshot).settings.content, Buffer.from(JSON.stringify({ packages: [], skills: [], theme: "fixture-dark", defaultModel: "local-choice", editorPaddingX: 2 })).toString("base64"));
	assert.equal(existsSync(join(repo, "calls.log")), false, "no code from the Catalog is run");
}));

test("Managed generated output receipts permit subsequent updates and current-source configuration application", () => fixture(({ repo, git, invoke, register, review, sync, update }) => {
	register(); update("First safe update.\n"); const first = sync(review()); assert.equal(first.ok, true, JSON.stringify(first));
	assert.equal(invoke({}).dirty, false, "only exact compiler-owned bytes are accepted");
	update("Second safe update.\n"); const secondReview = review(); assert.equal(secondReview.canSync, true); const second = sync(secondReview); assert.equal(second.ok, true, JSON.stringify(second));
	const current = review(); assert.equal(current.hasUpdate, false); assert.equal(current.canApplyConfiguration, true);
	const reapplied = sync(current); assert.equal(reapplied.ok, true, JSON.stringify(reapplied)); assert.equal(reapplied.sourceChanged, false);
	assert.equal(git(repo, "rev-parse", "HEAD"), current.head);
	writeFileSync(join(repo, "AGENTS.md"), "External generated-file edit to preserve.\n");
	assert.equal(invoke({}).dirty, true); assert.equal(sync(review()).ok, false);
	assert.equal(readFileSync(join(repo, "AGENTS.md"), "utf8"), "External generated-file edit to preserve.\n");
}));

test("Install declaration changes are named and blocked before source/configuration mutation", () => fixture(({ repo, home, git, register, review, sync, updateFile }) => {
	register(); const before = git(repo, "rev-parse", "HEAD");
	updateFile("adapters/pi/settings.json", JSON.stringify({ packages: ["npm:fixture-package@1.2.3"], skills: [] }));
	const value = review(); assert.equal(value.summary.installationChanges[0].name, "fixture-package");
	const result = sync(value); assert.equal(result.ok, false); assert.equal(result.installationRequired, true);
	assert.equal(git(repo, "rev-parse", "HEAD"), before); assert.equal(existsSync(nativeSettings(home)), false);
	assert.equal(readdirSync(join(home, ".local/state/harness/catalog-sync")).some(name => name.startsWith("configuration-")), false);
}));

test("Unchanged but missing native package is an explicit repair item, not an implicit download", () => fixture(({ source, repo, home, git, register, review, sync }) => {
	writeFileSync(join(source, "adapters/pi/settings.json"), JSON.stringify({ packages: ["npm:fixture-package@1.2.3"], skills: [] }));
	git(source, "add", "adapters/pi/settings.json"); git(source, "commit", "-m", "fixture: prior declaration"); git(repo, "pull", "--ff-only");
	register(); const value = review(); assert.equal(value.summary.requiresInstallation, false); assert.equal(value.summary.missingInstallations[0].operation, "repair");
	assert.equal(sync(value).installationRequired, true); assert.equal(existsSync(join(home, ".pi/agent/npm")), false);
}));

test("Invalid native settings and parent symlinks stop before Git and preserve outside entities", () => fixture(({ root, repo, home, git, register, review, sync, update }) => {
	register(); update("Blocked update.\n"); const value = review(), before = git(repo, "rev-parse", "HEAD");
	writeSettings(home, "malformed native fixture");
	assert.match(sync(value).error, /设置无效/); assert.equal(git(repo, "rev-parse", "HEAD"), before); assert.equal(readFileSync(nativeSettings(home), "utf8"), "malformed native fixture");
	rmSync(join(home, ".pi"), { recursive: true }); const outside = join(root, "outside"); mkdirSync(outside); symlinkSync(outside, join(home, ".pi"));
	assert.match(sync(value).error, /父目录含符号链接/); assert.equal(git(repo, "rev-parse", "HEAD"), before); assert.deepEqual(readdirSync(outside), []);
}));

for (const kind of ["shared", "external", "dangling"]) {
	test(`Native settings ${kind} symlink is refused before HEAD fast-forward without losing personal bytes`, () => fixture(({ root, source, repo, home, git, register, review, sync, update, updateFile }) => {
		const oldText = '{"packages":[],"skills":[],"theme":"old-personal-theme","defaultModel":"old-personal-model"}\n';
		const target = kind === "shared" ? join(repo, "adapters/pi/settings.json") : join(root, `${kind}-settings.json`);
		if (kind === "shared") {
			updateFile("adapters/pi/settings.json", oldText); git(repo, "pull", "--ff-only");
		} else if (kind === "external") writeFileSync(target, oldText, { mode: 0o600 });
		mkdirSync(join(home, ".pi/agent"), { recursive: true }); symlinkSync(target, nativeSettings(home));
		register(); const before = git(repo, "rev-parse", "HEAD");
		if (kind === "shared") updateFile("adapters/pi/settings.json", '{"packages":[],"skills":[]}\n');
		else update("Do not apply while native settings are a symlink.\n");
		const value = review(); assert.equal(value.canSync, true); assert.notEqual(value.commit, before);
		const result = sync(value); assert.equal(result.ok, false); assert.match(result.error, /本机设置仍是旧投影/);
		assert.equal(git(repo, "rev-parse", "HEAD"), before); assert.equal(lstatSync(nativeSettings(home)).isSymbolicLink(), true);
		assert.equal(readlinkSync(nativeSettings(home)), target);
		if (kind === "dangling") assert.equal(existsSync(target), false);
		else assert.equal(readFileSync(target, "utf8"), oldText);
		if (kind === "shared") assert.equal(readFileSync(join(source, "adapters/pi/settings.json"), "utf8"), '{"packages":[],"skills":[]}\n');
		assert.equal(readdirSync(join(home, ".local/state/harness/catalog-sync")).some(name => name.startsWith("configuration-")), false);
	}));
}

test("Shared settings without packages preserve native packages and theme while sync succeeds", () => fixture(({ repo, home, git, register, review, sync, update, updateFile }) => {
	updateFile("adapters/pi/settings.json", '{"skills":[]}\n'); git(repo, "pull", "--ff-only");
	const packages = ["npm:fixture-personal-package@1.2.3", { source: "./fixture-personal-resource", extensions: ["fixture.ts"] }];
	writeSettings(home, JSON.stringify({ packages, skills: ["old-native-skill"], theme: "native-theme", defaultModel: "native-model" }));
	register(); update("Sync a Catalog with no package declaration.\n"); const value = review();
	assert.equal(value.summary.requiresInstallation, false); assert.deepEqual(value.summary.missingInstallations, []);
	const result = sync(value); assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.synced, true); assert.equal(result.configurationApplied, true); assert.equal(result.needsApply, false);
	assert.equal(git(repo, "rev-parse", "HEAD"), value.commit);
	assert.deepEqual(JSON.parse(readFileSync(nativeSettings(home), "utf8")), { packages, skills: [], theme: "native-theme", defaultModel: "native-model" });
	assert.equal(existsSync(join(home, ".pi/agent/npm")), false, "sync never installs native packages");
}));

test("Configuration phase failure records partial success and leaves source for explicit recovery", () => fixture(({ root, repo, git, register, review, sync, update }) => {
	const engine = join(root, "trusted-test-engine"); mkdirSync(join(engine, "scripts"), { recursive: true });
	writeFileSync(join(engine, "scripts/harness.mjs"), 'console.error("fixture phase failure"); process.exit(9);\n');
	register(); update("Configuration phase fails after safe source update.\n"); const value = review(); const result = sync(value, { engine });
	assert.equal(result.ok, false); assert.equal(result.synced, true); assert.equal(result.configurationApplied, false); assert.equal(result.needsApply, true); assert.equal(result.recoveryRequired, true);
	assert.equal(result.phases[0].status, "failed"); assert.equal(result.phases[0].code, 9); assert.match(readFileSync(result.phases[0].log, "utf8"), /fixture phase failure/); assert.equal(git(repo, "rev-parse", "HEAD"), value.commit);
	assert.equal(existsSync(result.backup), true); assert.equal(existsSync(result.configurationBackup), true);
}));

test("Source edits during generation and branch switches are not overwritten or silently accepted", () => fixture(({ root, repo, git, register, review, sync, update }) => {
	register(); update("Race fixture update.\n"); const value = review();
	git(repo, "switch", "-c", "external-branch"); assert.equal(sync(value).ok, false); git(repo, "switch", "main");
	const engine = join(root, "trusted-race-engine"); mkdirSync(join(engine, "scripts"), { recursive: true });
	writeFileSync(join(engine, "scripts/harness.mjs"), `import {readFileSync,writeFileSync} from 'node:fs'; import {join} from 'node:path'; const path=join(process.env.HARNESS_CATALOG,'profiles/medium.json'); const value=JSON.parse(readFileSync(path)); value.label='External writer preserved'; writeFileSync(path,JSON.stringify(value));`);
	const result = sync(review(), { engine }); assert.equal(result.ok, false); assert.equal(result.synced, true); assert.match(result.error, /其他程序修改/);
	assert.equal(JSON.parse(readFileSync(join(repo, "profiles/medium.json"))).label, "External writer preserved");
}));
