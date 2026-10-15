import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "./index.mjs";

function fixture() {
	const values = new Map(), sent = [];
	let handler, reads = 0, requests = 0, allowed = false, granted = false, saveFails = false, pending;
	const host = {
		storage: {
			get: (key) => values.get(key),
			set: (key, value) => { if (saveFails) throw Error("disk failure"); values.set(key, value); },
		},
		fs: {
			authorizedDirs: () => granted ? [sent.at(-1)?.directory] : [],
			requestAccess: async () => { requests++; const result = pending ? await pending : allowed; granted = result; return result; },
			listPath: async () => { if (!granted) throw Error("native permission denied"); reads++; return []; },
			readTextPath: async () => { throw Error("unexpected read"); },
		},
		onMessage: (callback) => { handler = callback; return () => {}; }, onAttach: () => () => {},
		schedule: () => () => {}, log: () => {}, sendTo: (_client, state) => sent.push(state), broadcast: (state) => sent.push(state),
	};
	return {
		values, sent, host, start: () => plugin.activate(host), message: (payload) => handler(payload, "owned-browser"),
		allow: (value) => { allowed = value; }, revoke: () => { granted = false; }, failSave: () => { saveFails = true; },
		defer: (promise) => { pending = promise; }, get reads() { return reads; }, get requests() { return requests; },
	};
}

test("remember access is opt-in, survives plugin/service activation, and never bypasses native directory revocation", async () => {
	const f = fixture(); let close = await f.start();
	await f.message({ type: "observer-get" }); assert.equal(f.reads, 0);
	await f.message({ type: "observer-remember-access", remember: true });
	assert.equal(f.values.size, 0, "a checkbox cannot itself authorize reading");
	await f.message({ type: "observer-authorize", remember: true });
	assert.equal(f.values.size, 0, "declined approval cannot be remembered");
	f.allow(true); await f.message({ type: "observer-authorize", remember: true });
	assert.equal(f.sent.at(-1).authorized, true); assert.equal(f.sent.at(-1).rememberAccess, true);
	const preference = [...f.values.values()][0]; assert.equal(preference.directory, f.sent.at(-1).directory);
	const requests = f.requests; close(); close = await f.start();
	await f.message({ type: "observer-get" });
	assert.equal(f.sent.at(-1).authorized, true); assert.equal(f.requests, requests, "no repeated permission prompt when remembered and still valid");
	f.revoke(); const reads = f.reads; await f.message({ type: "observer-refresh" });
	assert.equal(f.reads, reads); assert.equal(f.sent.at(-1).authorized, false);
	assert.ok(f.sent.at(-1).error.includes("不会绕过宿主权限"));
	await f.message({ type: "observer-get" }); assert.equal(f.requests, requests, "revocation must not trigger automatic re-approval");
	close();
});

test("temporary access and canceled remembering expire at activation even if the host retains a broader grant", async () => {
	const f = fixture(); f.allow(true); let close = await f.start();
	await f.message({ type: "observer-authorize", remember: false });
	assert.equal(f.sent.at(-1).authorized, true); assert.equal(f.sent.at(-1).rememberAccess, false);
	close(); close = await f.start(); const reads = f.reads;
	await f.message({ type: "observer-get" }); assert.equal(f.reads, reads); assert.equal(f.sent.at(-1).authorized, false);
	await f.message({ type: "observer-authorize", remember: true });
	await f.message({ type: "observer-remember-access", remember: false });
	assert.equal(f.sent.at(-1).authorized, true, "turning remembering off does not interrupt the current view");
	close(); close = await f.start(); await f.message({ type: "observer-get" });
	assert.equal(f.sent.at(-1).authorized, false);
	close();
});

test("wrong-directory, malformed or old-schema preferences do not authorize; storage failures remain explicit", async () => {
	for (const value of [true, [], { schemaVersion: 1, remember: true, directory: "/different-directory" }, { schemaVersion: 99, remember: true }]) {
		const f = fixture(); f.values.set("observer-directory-access", value); const close = await f.start();
		await f.message({ type: "observer-get" }); assert.equal(f.reads, 0); assert.equal(f.requests, 0); assert.equal(f.sent.at(-1).authorized, false); close();
	}
	const f = fixture(); f.allow(true); f.failSave(); let close = await f.start();
	await f.message({ type: "observer-authorize", remember: true });
	assert.equal(f.sent.at(-1).rememberAccess, false); assert.ok(f.sent.at(-1).error.includes("保存"));
	close(); close = await f.start(); const reads = f.reads; await f.message({ type: "observer-get" });
	assert.equal(f.reads, reads); close();
});

test("duplicate pending approvals share a request and disposed activations cannot persist or publish late approval", async () => {
	const f = fixture(); let finish; f.defer(new Promise((resolve) => { finish = resolve; }));
	const close = await f.start(); const first = f.message({ type: "observer-authorize", remember: true });
	const second = f.message({ type: "observer-authorize", remember: true });
	assert.equal(f.requests, 1); close(); finish(true); await Promise.all([first, second]);
	assert.equal(f.values.size, 0); assert.equal(f.sent.length, 0); assert.equal(f.reads, 0);
});
