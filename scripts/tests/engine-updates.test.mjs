import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runEngineUpdates } from "../lib/engine-updates.mjs";
import { createEngineUpdatesFixture } from "./engine-updates-fixture.mjs";
import { createWebFixture } from "./web-fixture.mjs";
import { startHarnessWeb } from "../web.mjs";

async function fixture(action) {
	const value = createEngineUpdatesFixture();
	const invoke = options => runEngineUpdates({ engine: value.engine, home: value.home, ...options });
	try { await action({ ...value, invoke }); }
	finally { value.restoreEnvironment(); rmSync(value.root, { recursive: true, force: true }); }
}

const stateFile = home => {
	const directory = join(home, ".local/state/harness/engine-updates");
	return join(directory, readdirSync(directory).find(file => file.endsWith(".json")));
};

test("Engine status is offline; opt-in/CAS persists; explicit check compares commits without applying", () => fixture(({ engine, home, source, invoke, update, git }) => {
	const initial = invoke();
	assert.equal(initial.ok, true, JSON.stringify(initial));
	assert.equal(initial.comparison, "unchecked"); assert.equal(initial.automaticCheck, false);
	assert.equal(existsSync(join(home, ".local/state/harness")), false, "offline status creates no state or lock");
	const configured = invoke({ operation: "configure", automaticCheck: true, expectedHash: initial.preferencesHash });
	assert.equal(configured.ok, true); assert.equal(configured.automaticCheck, true); assert.equal(configured.commit, null);
	assert.equal(invoke({ operation: "configure", automaticCheck: false, expectedHash: initial.preferencesHash }).status, 409);
	assert.equal(statSync(stateFile(home)).mode & 0o777, 0o600);
	const head = git(engine, "rev-parse", "HEAD"), trackedRemote = git(engine, "rev-parse", "refs/remotes/origin/main");
	update(); assert.equal(invoke().commit, null, "offline status cannot discover the upstream update");
	const checked = invoke({ operation: "check", force: true });
	assert.equal(checked.ok, true, JSON.stringify(checked)); assert.equal(checked.hasUpdate, true);
	assert.equal(checked.comparison, "behind"); assert.equal(checked.remoteVersion, "0.2.0"); assert.equal(checked.version, "0.1.0");
	assert.equal(checked.commit, git(source, "rev-parse", "HEAD"));
	assert.equal(git(engine, "rev-parse", "HEAD"), head); assert.equal(git(engine, "rev-parse", "refs/remotes/origin/main"), trackedRemote);
	assert.equal(JSON.parse(readFileSync(join(engine, "package.json"))).version, "0.1.0");
	assert.equal(git(engine, "status", "--porcelain"), "");
	update("0.3.0");
	assert.equal(invoke({ operation: "check" }).commit, checked.commit, "checks throttle at 15 minutes");
	assert.equal(invoke({ operation: "check", force: true }).remoteVersion, "0.3.0");
}));

test("Same version number can have new commits; current, ahead, divergent and rolled-back histories are distinct", () => fixture(({ engine, source, invoke, git }) => {
	const baseline = git(engine, "rev-parse", "HEAD");
	assert.equal(invoke({ operation: "check", force: true }).comparison, "current");
	writeFileSync(join(source, "README.md"), "New commit, unchanged semver.\n");
	git(source, "add", "."); git(source, "commit", "-m", "fixture: new commit");
	const newer = invoke({ operation: "check", force: true });
	assert.equal(newer.remoteVersion, "0.1.0"); assert.equal(newer.hasUpdate, true);
	git(engine, "merge", "--ff-only", newer.commit);
	assert.equal(invoke().comparison, "current", "local HEAD changes are reflected without network");
	writeFileSync(join(engine, "README.md"), "Local commit.\n"); git(engine, "add", "."); git(engine, "commit", "-m", "fixture: local commit");
	assert.equal(invoke().comparison, "ahead"); assert.equal(invoke().hasUpdate, false);
	writeFileSync(join(source, "README.md"), "Independent remote commit.\n"); git(source, "add", "."); git(source, "commit", "-m", "fixture: remote divergence");
	const divergent = invoke({ operation: "check", force: true });
	assert.equal(divergent.comparison, "diverged"); assert.equal(divergent.hasUpdate, false);
	git(source, "update-ref", "refs/heads/main", baseline);
	const rolledBack = invoke({ operation: "check", force: true });
	assert.equal(rolledBack.comparison, "ahead"); assert.equal(rolledBack.hasUpdate, false, "rollback is not a newer release");
}));

test("Failed fetch retains explicitly stale results and is throttled; changed/unsafe sources never leak credentials", () => fixture(({ engine, source, home, invoke, git }) => {
	const good = invoke({ operation: "check", force: true });
	git(source, "update-ref", "-d", "refs/heads/main");
	const failed = invoke({ operation: "check", force: true });
	assert.equal(failed.ok, false); assert.equal(failed.status, 422); assert.equal(failed.checkFailed, true);
	assert.equal(failed.checkedAt, good.checkedAt); assert.equal(failed.commit, good.commit);
	assert.match(invoke().message, /上次成功/);
	assert.equal(invoke({ operation: "check" }).checkFailed, true);
	const originalState = readFileSync(stateFile(home), "utf8");
	git(engine, "remote", "set-url", "origin", "https://user:do-not-leak@example.test/engine.git");
	const unsafe = invoke();
	assert.equal(unsafe.source, null); assert.equal(unsafe.commit, null); assert.equal(unsafe.hasUpdate, false);
	assert.equal(JSON.stringify(unsafe).includes("do-not-leak"), false);
	assert.equal(invoke({ operation: "check", force: true }).status, 400);
	assert.equal(readFileSync(stateFile(home), "utf8"), originalState);
	git(engine, "remote", "set-url", "origin", "git@github.com:example/engine.git");
	assert.equal(invoke().source, null); assert.equal(invoke({ operation: "check" }).status, 400);
	git(engine, "remote", "set-url", "origin", "https://example.test/other-engine.git");
	assert.equal(invoke().commit, null, "source changes invalidate the cache without fetching");
}));

test("Checking tolerates dirty Engine, disables hooks/fsmonitor, isolates caller Git redirects, and preserves native files", () => fixture(({ root, engine, source, home, invoke, update, git }) => {
	writeFileSync(join(engine, "README.md"), "Uncommitted local fix.\n");
	writeFileSync(join(engine, "untracked.txt"), "Keep me.\n");
	mkdirSync(join(home, ".pi/agent"), { recursive: true });
	for (const file of ["settings.json", "auth.json"]) writeFileSync(join(home, ".pi/agent", file), `{"fixture":"${file}"}`);
	const marker = join(root, "hook-ran"), monitor = join(root, "fsmonitor");
	writeFileSync(join(engine, ".git/hooks/reference-transaction"), `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(join(engine, ".git/hooks/reference-transaction"), 0o755);
	writeFileSync(monitor, `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(monitor, 0o755); git(engine, "config", "core.fsmonitor", monitor);
	update();
	const old = process.env.GIT_DIR; process.env.GIT_DIR = join(source, ".git");
	try {
		const checked = invoke({ operation: "check", force: true });
		assert.equal(checked.ok, true, JSON.stringify(checked)); assert.equal(checked.dirty, true); assert.equal(checked.hasUpdate, true);
		assert.notEqual(checked.head, checked.commit);
	} finally { if (old === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = old; }
	assert.equal(existsSync(marker), false); assert.equal(existsSync(join(engine, "never-install")), false);
	assert.equal(readFileSync(join(engine, "README.md"), "utf8"), "Uncommitted local fix.\n");
	assert.equal(readFileSync(join(engine, "untracked.txt"), "utf8"), "Keep me.\n");
	for (const file of ["settings.json", "auth.json"]) assert.equal(readFileSync(join(home, ".pi/agent", file), "utf8"), `{"fixture":"${file}"}`);
}));

test("Locks, unsupported operations, Git source rewrites, symlink state and non-Engine candidates fail safely", () => fixture(({ engine, home, source, invoke, git }) => {
	assert.equal(invoke({ operation: "apply" }).status, 400);
	assert.equal(invoke({ operation: "configure", automaticCheck: "true" }).status, 400);
	assert.equal(invoke({ operation: "check", force: true }).ok, true);
	const file = stateFile(home); writeFileSync(`${file}.harness.lock`, "external owner\n");
	assert.equal(invoke({ operation: "check", force: true }).status, 423);
	assert.equal(readFileSync(`${file}.harness.lock`, "utf8"), "external owner\n"); rmSync(`${file}.harness.lock`);
	git(engine, "config", "url.https://other.example/.insteadOf", "https://example.test/");
	assert.equal(invoke({ operation: "check", force: true }).status, 409); git(engine, "config", "--remove-section", "url.https://other.example/");
	writeFileSync(join(source, "package.json"), '{"name":"unrelated-project","version":"1.0.0"}'); git(source, "add", "."); git(source, "commit", "-m", "fixture: invalid engine");
	const invalid = invoke({ operation: "check", force: true }); assert.equal(invalid.ok, false); assert.equal(invalid.status, 422); assert.equal(invalid.hasUpdate, false);
	const state = readFileSync(file, "utf8"), linked = join(home, "linked-state"); writeFileSync(linked, state); rmSync(file); symlinkSync(linked, file);
	assert.equal(invoke().status, 400); assert.equal(readFileSync(linked, "utf8"), state);
}));

test("Offline Engine status never executes custom clean/process filters", () => fixture(({ root, engine, invoke, git }) => {
	writeFileSync(join(engine, ".gitattributes"), "README.md filter=fixture\n"); git(engine, "add", "."); git(engine, "commit", "-m", "fixture: filter attributes");
	const marker = join(root, "filter-ran"), script = join(root, "clean-filter");
	writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n/bin/cat\n`); chmodSync(script, 0o755);
	git(engine, "config", "filter.fixture.clean", script);
	writeFileSync(join(engine, "README.md"), "Different Engine version.\n");
	const result = invoke();
	assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.dirty, null); assert.match(result.worktreeWarning, /过滤器/);
	assert.equal(existsSync(marker), false);
	git(engine, "status", "--porcelain"); assert.equal(existsSync(marker), true, "fixture demonstrates that ordinary Git status would execute the filter");
}));

test("Automatic checks honor freshly reloaded server opt-in even when another page caches enabled preferences", () => fixture(({ engine, source, invoke, update, git }) => {
	const initial = invoke();
	assert.equal(invoke({ operation: "check", automatic: true, force: true }).commit, null);
	const enabled = invoke({ operation: "configure", automaticCheck: true, expectedHash: initial.preferencesHash });
	const good = invoke({ operation: "check", automatic: true, force: true }); assert.equal(good.comparison, "current");
	const disabled = invoke({ operation: "configure", automaticCheck: false, expectedHash: enabled.preferencesHash }); assert.equal(disabled.automaticCheck, false);
	update();
	const ignored = invoke({ operation: "check", automatic: true, force: true }); assert.equal(ignored.commit, good.commit); assert.equal(ignored.automaticCheck, false);
	assert.notEqual(ignored.commit, git(source, "rev-parse", "HEAD"));
	assert.equal(invoke({ operation: "check", force: true }).hasUpdate, true, "manual checking remains available without automatic opt-in");
}));

test("Engine HTTP checks are authenticated, server-rooted, and independent of Catalog sync", () => fixture(async ({ root, engine, home, update, git }) => {
	const catalog = createWebFixture();
	const instance = await startHarnessWeb({ repo: catalog, engine, syncHome: home, models: [], piResources: {} });
	const post = (cookie, value, origin = instance.origin) => fetch(`${instance.origin}/api/engine-updates`, { method: "POST", headers: { cookie, origin, "Content-Type": "application/json" }, body: JSON.stringify(value) });
	try {
		assert.equal((await fetch(`${instance.origin}/api/engine-updates`)).status, 401);
		const auth = await fetch(instance.url, { redirect: "manual" }); const cookie = auth.headers.get("set-cookie").split(";")[0];
		const get = () => fetch(`${instance.origin}/api/engine-updates`, { headers: { cookie } }).then(response => response.json());
		const initial = await get(); assert.equal(initial.engine, engine); assert.equal(initial.commit, null);
		const catalogProfile = readFileSync(join(catalog, "profiles/medium.json"), "utf8");
		const head = git(engine, "rev-parse", "HEAD"); update();
		const checked = await post(cookie, { operation: "check", force: true, engine: catalog, repo: "/", home: "/", source: "https://evil.example", branch: "other", remote: "other" });
		assert.equal(checked.status, 200); const result = await checked.json(); assert.equal(result.engine, engine); assert.equal(result.hasUpdate, true);
		assert.equal(git(engine, "rev-parse", "HEAD"), head); assert.equal(readFileSync(join(catalog, "profiles/medium.json"), "utf8"), catalogProfile);
		assert.equal(existsSync(join(catalog, "calls.log")), false); assert.equal(existsSync(join(root, "never-install")), false);
		assert.equal((await post(cookie, { operation: "apply" })).status, 400);
		assert.equal((await post(cookie, { operation: "configure", automaticCheck: true, expectedHash: result.preferencesHash })).status, 200);
		assert.equal((await get()).automaticCheck, true);
		assert.equal((await post(cookie, { operation: "check" }, "https://evil.example")).status, 403);
	} finally {
		await new Promise(resolve => { instance.server.close(resolve); instance.server.closeAllConnections(); });
		rmSync(catalog, { recursive: true, force: true });
	}
}));
