import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startHarnessWeb } from "../web.mjs";
import { createWebFixture, MODEL_OUTPUT } from "./web-fixture.mjs";

async function fixtureServer(action) {
	const root = createWebFixture();
	const instance = await startHarnessWeb({ repo: root, engine: root, modelOutput: MODEL_OUTPUT });
	try { await action({ root, instance }); }
	finally {
		await new Promise((resolve) => { instance.server.close(resolve); instance.server.closeAllConnections(); });
		rmSync(root, { recursive: true, force: true });
	}
}

function rawRequest(instance, headers) {
	return new Promise((resolve, reject) => {
		const req = request(instance.origin, { headers }, (response) => {
			response.resume();
			response.on("end", () => resolve(response.statusCode));
		});
		req.on("error", reject);
		req.end();
	});
}

async function authorize(instance) {
	const response = await fetch(instance.url, { redirect: "manual" });
	assert.equal(response.status, 303);
	assert.equal(response.headers.get("location"), "/");
	const cookie = response.headers.get("set-cookie");
	assert.match(cookie, /HttpOnly/);
	assert.match(cookie, /SameSite=Strict/);
	return cookie.split(";")[0];
}

function post(instance, cookie, path, value) {
	return fetch(`${instance.origin}${path}`, {
		method: "POST", headers: { cookie, origin: instance.origin, "Content-Type": "application/json" }, body: JSON.stringify(value),
	});
}

async function catalog(instance, cookie) {
	return (await fetch(`${instance.origin}/api/catalog`, { headers: { cookie } })).json();
}

test("Web HTTP rejects unauthorized, forged Host, malformed-cookie and cross-origin access", async () => {
	await fixtureServer(async ({ instance }) => {
		assert.equal((await fetch(`${instance.origin}/api/catalog`)).status, 401);
		assert.equal((await fetch(`${instance.origin}/?token=invalid`, { redirect: "manual" })).status, 401);
		const cookie = await authorize(instance);
		assert.equal(await rawRequest(instance, { host: "evil.example" }), 403);
		assert.equal((await fetch(`${instance.origin}/api/catalog`, { headers: { cookie: `${cookie.split("=")[0]}=%invalid` } })).status, 401);
		assert.equal((await fetch(`${instance.origin}/api/catalog`, { headers: { cookie, origin: "https://evil.example" } })).status, 403);
		const response = await fetch(`${instance.origin}/api/catalog`, { headers: { cookie } });
		assert.equal(response.status, 200);
		assert.equal((await response.json()).profiles.length, 3);
		assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
		assert.equal((await fetch(`${instance.origin}/api/doctor`, { method: "POST", headers: { cookie }, body: "{}" })).status, 403);
		assert.equal((await fetch(`${instance.origin}/scripts/harness.mjs`)).status, 404);
		assert.equal((await fetch(`${instance.origin}/`)).status, 200);
		assert.equal((await post(instance, cookie, "/api/save-profile", null)).status, 400);
		assert.equal((await post(instance, cookie, "/api/save-profile", { text: "x".repeat(2 * 1024 * 1024) })).status, 413);
	});
});

test("Web HTTP save uses CAS, validates names, preserves conflicts, and rolls back failures", async () => {
	await fixtureServer(async ({ root, instance }) => {
		const cookie = await authorize(instance);
		const originalCatalog = await catalog(instance, cookie);
		const profile = originalCatalog.profiles.find((entry) => entry.name === "medium");
		const changed = structuredClone(profile.value);
		changed.description = "HTTP save fixture";
		assert.equal((await post(instance, cookie, "/api/save-profile", { name: "../../escape", expectedHash: profile.sourceHash, value: changed })).status, 400);
		assert.equal((await post(instance, cookie, "/api/save-profile", { name: "medium", value: null })).status, 400);
		assert.equal((await post(instance, cookie, "/api/save-profile", { name: "profile.schema", expectedHash: profile.sourceHash, value: changed })).status, 400);
		const result = await post(instance, cookie, "/api/save-profile", { name: "medium", expectedHash: profile.sourceHash, value: changed });
		assert.equal(result.status, 200, JSON.stringify(await result.json()));
		assert.match(readFileSync(join(root, "profiles/medium.json"), "utf8"), /HTTP save fixture/);
		const conflict = await post(instance, cookie, "/api/save-profile", { name: "medium", expectedHash: profile.sourceHash, value: changed });
		assert.equal(conflict.status, 409);
		const updatedProfile = (await catalog(instance, cookie)).profiles.find((entry) => entry.name === "medium");
		const original = readFileSync(join(root, "profiles/medium.json"), "utf8");
		writeFileSync(join(root, "fail-compose"), "fail\n");
		changed.description = "must rollback";
		const failed = await post(instance, cookie, "/api/save-profile", { name: "medium", expectedHash: updatedProfile.sourceHash, value: changed });
		assert.equal(failed.status, 422);
		assert.equal(readFileSync(join(root, "profiles/medium.json"), "utf8"), original);
	});
});

test("Web HTTP manages new and copied Profiles without requiring a preset to survive", async () => {
	await fixtureServer(async ({ root, instance }) => {
		const cookie = await authorize(instance);
		const profiles = (await catalog(instance, cookie)).profiles;
		const value = { ...profiles[0].value, label: "Custom copy" };
		assert.equal((await post(instance, "", "/api/create-profile", { name: "custom", value })).status, 401);
		assert.equal((await post(instance, cookie, "/api/create-profile", { name: "../escape", value })).status, 400);
		assert.equal((await post(instance, cookie, "/api/create-profile", { name: "custom", value })).status, 201);
		assert.equal((await post(instance, cookie, "/api/create-profile", { name: "custom", value })).status, 409);
		assert.equal((await post(instance, cookie, "/api/delete-profile", { name: "custom" })).status, 400);
		assert.equal((await post(instance, cookie, "/api/delete-profile", { name: "custom", expectedHash: "0".repeat(64) })).status, 409);
		for (const profile of profiles) {
			const deleted = await post(instance, cookie, "/api/delete-profile", { name: profile.name, expectedHash: profile.sourceHash });
			assert.equal(deleted.status, 200, JSON.stringify(await deleted.json()));
		}
		const remaining = (await catalog(instance, cookie)).profiles;
		assert.deepEqual(remaining.map((profile) => profile.name), ["custom"]);
		assert.equal((await post(instance, cookie, "/api/delete-profile", { name: "custom", expectedHash: remaining[0].sourceHash })).status, 400);
		const invalid = await post(instance, cookie, "/api/create-profile", { name: "invalid", value: { ...value, skills: ["missing-skill"] } });
		assert.equal(invalid.status, 422);
		assert.equal((await invalid.json()).rollbackVerified, true);
		assert.equal((await catalog(instance, cookie)).profiles.length, 1);
		assert.match(readFileSync(join(root, "profiles/custom.json"), "utf8"), /Custom copy/);
	});
});

test("Web HTTP accepts composer-valid Profile names without exposing the schema", async () => {
	await fixtureServer(async ({ root, instance }) => {
		const original = readFileSync(join(root, "profiles/medium.json"), "utf8");
		writeFileSync(join(root, "profiles/Alpha.1.json"), original);
		const cookie = await authorize(instance);
		const entry = (await catalog(instance, cookie)).profiles.find((item) => item.name === "Alpha.1");
		const result = await post(instance, cookie, "/api/save-profile", { name: entry.name, expectedHash: entry.sourceHash, value: { ...entry.value, label: "named profile" } });
		assert.equal(result.status, 200, JSON.stringify(await result.json()));
	});
});

test("Web HTTP edits full Markdown variants and real composer prevents disabling Mandatory", async () => {
	await fixtureServer(async ({ root, instance }) => {
		const cookie = await authorize(instance);
		const original = await catalog(instance, cookie);
		const entry = original.instructions.find((item) => item.id === "profile/implementation");
		const text = "## Implementation\n\nEdited full replacement text.\n";
		const result = await post(instance, cookie, "/api/save-instruction-text", { id: entry.id, detail: "brief", expectedHash: entry.variantHashes.brief, text });
		assert.equal(result.status, 200, JSON.stringify(await result.json()));
		assert.equal(readFileSync(join(root, "instructions/profile/implementation.brief.md"), "utf8"), text);
		assert.equal((await post(instance, cookie, "/api/save-instruction-text", { id: "../../escape", detail: "brief", expectedHash: entry.variantHashes.brief, text })).status, 400);
		const source = readFileSync(join(root, "instructions/selection.json"), "utf8");
		const disabled = structuredClone(original.globalInstructions.value);
		disabled.mandatory = [];
		const failed = await post(instance, cookie, "/api/save-instructions", { expectedHash: original.globalInstructions.sourceHash, value: disabled });
		assert.equal(failed.status, 422);
		const failure = await failed.json();
		assert.equal(failure.rollbackVerified, true);
		assert.match(failure.logs[0].output, /include every mandatory entry/);
		assert.equal(readFileSync(join(root, "instructions/selection.json"), "utf8"), source);
	});
});

test("Web HTTP serializes cross-profile writes without blocking read requests", async () => {
	await fixtureServer(async ({ root, instance }) => {
		const cookie = await authorize(instance);
		const original = await catalog(instance, cookie);
		writeFileSync(join(root, "slow-compose"), "slow\n");
		const medium = original.profiles.find((item) => item.name === "medium");
		const heavy = original.profiles.find((item) => item.name === "heavy");
		const saving = post(instance, cookie, "/api/save-profile", { name: "medium", expectedHash: medium.sourceHash, value: { ...medium.value, label: "slow save" } });
		for (let attempt = 0; attempt < 100; attempt++) {
			try { readFileSync(join(root, ".catalog.harness.lock")); break; }
			catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
		}
		const started = performance.now();
		assert.equal((await catalog(instance, cookie)).ok, true);
		assert.ok(performance.now() - started < 800, "read requests must stay responsive during compose");
		assert.equal((await post(instance, cookie, "/api/save-profile", { name: "heavy", expectedHash: heavy.sourceHash, value: { ...heavy.value, label: "conflicting save" } })).status, 423);
		assert.equal((await saving).status, 200);
	});
});
