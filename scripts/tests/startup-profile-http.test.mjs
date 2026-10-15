import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ENGINE } from "../lib/repo.mjs";
import { runStartupProfile } from "../lib/startup-profile.mjs";
import { startHarnessWeb } from "../web.mjs";
import { createWebFixture, MODEL_OUTPUT } from "./web-fixture.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const stateDirectory = home => join(home, ".local/state/harness/startup-profile");
const stateFile = (home, catalog) => join(stateDirectory(home), `${digest(realpathSync(catalog))}.json`);

function snapshot(root) {
	const entries = {};
	function visit(directory, prefix = "") {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const relative = `${prefix}${entry.name}`, path = join(directory, entry.name);
			if (entry.isDirectory()) { entries[`${relative}/`] = null; visit(path, `${relative}/`); }
			else entries[relative] = readFileSync(path);
		}
	}
	visit(root);
	return entries;
}

async function fixture(action) {
	const roots = [], servers = [];
	const catalog = () => { const root = realpathSync(createWebFixture()); roots.push(root); return root; };
	const temporaryHome = () => { const home = realpathSync(mkdtempSync(join(tmpdir(), "harness-startup-http-home-"))); roots.push(home); return home; };
	const start = async (root, home) => {
		const instance = await startHarnessWeb({ repo: root, engine: root, syncHome: home, modelOutput: MODEL_OUTPUT, piResources: {} });
		servers.push(instance);
		const auth = await fetch(instance.url, { redirect: "manual" });
		assert.equal(auth.status, 303);
		const cookie = auth.headers.get("set-cookie");
		assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
		return { ...instance, cookie: cookie.split(";")[0] };
	};
	try {
		const root = catalog(), home = temporaryHome();
		for (const [path, text] of [
			[".pi/agent/settings.json", '{"theme":"fixture","defaultModel":"ordinary-model","packages":[]}\n'],
			[".pi-profile-switch/settings.json", '{"defaultProfile":"heavy"}\n'],
			[".pi-profile-switch/current.json", '{"profile":"heavy"}\n'],
		]) {
			const file = join(home, path);
			mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text);
		}
		mkdirSync(join(root, "adapters/pi"), { recursive: true });
		writeFileSync(join(root, "adapters/pi/settings.json"), '{"packages":[],"skills":[]}\n');
		await action({ root, home, instance: await start(root, home), start, catalog, temporaryHome });
	} finally {
		await Promise.all(servers.map(instance => new Promise(resolve => { instance.server.close(resolve); instance.server.closeAllConnections(); })));
		for (const root of roots) rmSync(root, { recursive: true, force: true });
	}
}

function get(instance, headers = {}) {
	return fetch(`${instance.origin}/api/startup-profile`, { headers: { cookie: instance.cookie, ...headers } });
}

function post(instance, value, headers = {}) {
	return fetch(`${instance.origin}/api/startup-profile`, {
		method: "POST", headers: { cookie: instance.cookie, origin: instance.origin, "Content-Type": "application/json", ...headers },
		body: JSON.stringify(value),
	});
}

async function result(response, status = 200) {
	const body = await response.json();
	assert.equal(response.status, status, JSON.stringify(body));
	assert.equal(body.ok, status === 200, JSON.stringify(body));
	assert.equal(body.status, status, JSON.stringify(body));
	return body;
}

function assertPreferenceOnly(home, before, catalogs) {
	const expected = { ...before, ".local/": null, ".local/state/": null, ".local/state/harness/": null, ".local/state/harness/startup-profile/": null };
	for (const catalog of catalogs) {
		const file = stateFile(home, catalog);
		expected[`.local/state/harness/startup-profile/${digest(realpathSync(catalog))}.json`] = readFileSync(file);
		assert.equal(statSync(file).mode & 0o777, 0o600);
	}
	assert.deepEqual(snapshot(home), expected, "only local startup preferences may change; no settings, runtime, installer or log writes");
	assert.equal(statSync(stateDirectory(home)).mode & 0o777, 0o700);
}

test("Startup Profile HTTP rejects unauthorized and cross-origin reads/writes without creating state", () => fixture(async ({ root, home, instance }) => {
	const before = [snapshot(root), snapshot(home)];
	assert.equal((await get(instance, { cookie: "" })).status, 401);
	assert.equal((await post(instance, { profile: "medium", expectedHash: digest("missing") }, { cookie: "" })).status, 401);
	assert.equal((await get(instance, { cookie: `${instance.cookie.split("=")[0]}=%invalid` })).status, 401);
	assert.equal((await get(instance, { origin: "https://evil.example" })).status, 403);
	assert.equal((await get(instance, { "sec-fetch-site": "cross-site" })).status, 403);
	for (const headers of [{ origin: "https://evil.example" }, { origin: "" }, { "Content-Type": "text/plain" }, { "sec-fetch-site": "cross-site" }]) {
		assert.equal((await post(instance, { profile: "medium", expectedHash: digest("missing") }, headers)).status, 403);
	}
	assert.deepEqual([snapshot(root), snapshot(home)], before);
	assert.equal(existsSync(stateDirectory(home)), false);
}));

test("Startup Profile HTTP absent GET is read-only and reports ordinary mode", () => fixture(async ({ root, home, instance }) => {
	const before = [snapshot(root), snapshot(home)];
	const expected = { ok: true, status: 200, profile: null, preferencesHash: digest("missing"), missing: false };
	assert.deepEqual(await result(await get(instance)), expected);
	assert.deepEqual(await result(await get(instance)), expected);
	assert.deepEqual(runStartupProfile({ catalog: root, home, engine: ENGINE }), expected);
	assert.deepEqual([snapshot(root), snapshot(home)], before, "GET must not compose, install, acquire locks or create preference state");
	assert.equal(existsSync(join(root, "calls.log")), false);
	assert.equal(existsSync(join(home, ".local")), false);
}));

test("Startup Profile HTTP persists across Web servers, isolates Catalogs, rejects stale CAS and resets to ordinary mode", () => fixture(async ({ root, home, instance, start, catalog }) => {
	const otherCatalog = catalog();
	const before = [snapshot(root), snapshot(otherCatalog)], homeBefore = snapshot(home);
	const initial = await result(await get(instance));
	const saved = await result(await post(instance, { profile: "medium", expectedHash: initial.preferencesHash }));
	assert.equal(saved.profile, "medium"); assert.equal(saved.missing, false);
	const file = stateFile(home, root), savedBytes = readFileSync(file);
	assert.deepEqual(JSON.parse(savedBytes), { schemaVersion: 1, profile: "medium" });
	assert.equal(saved.preferencesHash, digest(savedBytes));
	assert.deepEqual(runStartupProfile({ catalog: root, home, engine: ENGINE }), saved);
	const anotherWeb = await start(root, home), otherWeb = await start(otherCatalog, home);
	assert.deepEqual(await result(await get(anotherWeb)), saved);
	const otherInitial = await result(await get(otherWeb));
	assert.deepEqual(otherInitial, initial, "another Catalog in the same HOME has no inherited selection");
	const otherSaved = await result(await post(otherWeb, { profile: "heavy", expectedHash: otherInitial.preferencesHash }));
	assert.equal(otherSaved.profile, "heavy");
	assert.deepEqual(await result(await get(instance)), saved);
	await result(await post(anotherWeb, { profile: "heavy", expectedHash: initial.preferencesHash }), 409);
	assert.deepEqual(readFileSync(file), savedBytes, "stale CAS must not replace the preference");
	const reset = await result(await post(anotherWeb, { profile: null, expectedHash: saved.preferencesHash }));
	assert.equal(reset.profile, null); assert.equal(reset.missing, false);
	assert.notEqual(reset.preferencesHash, initial.preferencesHash, "explicit ordinary mode is persisted, not absent state");
	assert.deepEqual(JSON.parse(readFileSync(file)), { schemaVersion: 1, profile: null });
	assert.deepEqual(await result(await get(instance)), reset);
	assert.deepEqual(await result(await get(otherWeb)), otherSaved);
	assert.deepEqual([snapshot(root), snapshot(otherCatalog)], before, "preferences never compose or change Catalog/profile bytes");
	assertPreferenceOnly(home, homeBefore, [root, otherCatalog]);
}));

test("Startup Profile HTTP rejects invalid or missing names and missing/invalid CAS without writing", () => fixture(async ({ root, home, instance }) => {
	const before = [snapshot(root), snapshot(home)];
	const initial = await result(await get(instance));
	for (const profile of [undefined, "", "default", "DEFAULT", "profile.schema", "../medium", "/medium", "a/b", "a\\b", " medium", {}, [], false, 0, "a".repeat(201)]) {
		await result(await post(instance, { profile, expectedHash: initial.preferencesHash }), 400);
	}
	for (const expectedHash of [undefined, null, "", "invalid", "F".repeat(64)]) {
		await result(await post(instance, { profile: "medium", expectedHash }), 400);
	}
	await result(await post(instance, { profile: "not-installed", expectedHash: initial.preferencesHash }), 404);
	assert.equal((await post(instance, null)).status, 400);
	assert.deepEqual(await result(await get(instance)), initial);
	assert.deepEqual([snapshot(root), snapshot(home)], before);
}));

test("Startup Profile HTTP ignores body roots for both preference writes and Profile lookup", () => fixture(async ({ root, home, instance, start, catalog, temporaryHome }) => {
	const otherCatalog = catalog(), otherHome = temporaryHome();
	writeFileSync(join(otherCatalog, "profiles/other-only.json"), '{"label":"Other Catalog only"}\n');
	const before = [snapshot(root), snapshot(otherCatalog), snapshot(otherHome)], homeBefore = snapshot(home);
	const redirect = { home: otherHome, catalog: otherCatalog, engine: home, root: otherCatalog, repo: otherCatalog };
	const initial = await result(await get(instance));
	await result(await post(instance, { ...redirect, profile: "other-only", expectedHash: initial.preferencesHash }), 404);
	assert.equal(existsSync(stateDirectory(home)), false);
	const saved = await result(await post(instance, { ...redirect, profile: "medium", expectedHash: initial.preferencesHash }));
	assert.equal(saved.profile, "medium");
	assert.deepEqual(runStartupProfile({ catalog: root, home, engine: ENGINE }), saved, "independent reader confirms the trusted server roots");
	const otherWeb = await start(otherCatalog, otherHome);
	assert.deepEqual(await result(await get(otherWeb)), initial);
	assert.deepEqual(runStartupProfile({ catalog: otherCatalog, home, engine: ENGINE }), initial);
	assert.deepEqual([snapshot(root), snapshot(otherCatalog), snapshot(otherHome)], before);
	assertPreferenceOnly(home, homeBefore, [root]);
}));

test("Startup Profile HTTP retains a deleted selection as missing without fallback or state rewrites", () => fixture(async ({ root, home, instance }) => {
	const homeBefore = snapshot(home), catalogBefore = snapshot(root);
	const initial = await result(await get(instance));
	const saved = await result(await post(instance, { profile: "medium", expectedHash: initial.preferencesHash }));
	assert.deepEqual(snapshot(root), catalogBefore);
	const file = stateFile(home, root), bytes = readFileSync(file);
	rmSync(join(root, "profiles/medium.json"));
	const afterDeletion = [snapshot(root), snapshot(home)];
	const missing = { ...saved, missing: true };
	assert.deepEqual(await result(await get(instance)), missing);
	assert.deepEqual(await result(await get(instance)), missing);
	assert.deepEqual(runStartupProfile({ catalog: root, home, engine: ENGINE }), missing);
	assert.equal(existsSync(join(root, "profiles/heavy.json")), true, "an available alternative must not become the default");
	await result(await post(instance, { profile: "medium", expectedHash: saved.preferencesHash }), 404);
	assert.deepEqual(readFileSync(file), bytes);
	assert.deepEqual([snapshot(root), snapshot(home)], afterDeletion);
	assertPreferenceOnly(home, homeBefore, [root]);
}));
