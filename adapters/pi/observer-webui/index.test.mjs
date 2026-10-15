import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "./index.mjs";

test("Observer requires directory approval, polls bounded snapshots and disposes subscriptions", async () => {
	let message, attach, poll, approved = false, reads = 0, disposed = 0;
	const sent = [];
	const snapshot = { id: "42-parent", pid: 42, active: true, updatedAt: new Date().toISOString(),
		processInventory: { checkedAt: new Date().toISOString(), pids: [42, 99, 99, "invalid", -1] } };
	const host = {
		fs: {
			authorizedDirs: () => [],
			requestAccess: async () => approved,
			listPath: async () => { reads++; return [{ type: "file", name: "42-parent.snapshot.json" }]; },
			readTextPath: async (_path, limit) => { assert.equal(limit, 64 * 1024); return JSON.stringify(snapshot); },
		},
		onMessage: (handler) => { message = handler; return () => disposed++; },
		onAttach: (handler) => { attach = handler; return () => disposed++; },
		schedule: (interval, handler) => { assert.equal(interval, 15000); poll = handler; return () => disposed++; },
		sendTo: (_id, payload) => sent.push(payload),
		broadcast: (payload) => sent.push(payload),
		log: () => {},
	};
	const close = await plugin.activate(host);
	await message({ type: "observer-get" }, "browser");
	assert.equal(reads, 0);
	assert.equal(sent.at(-1).authorized, false);
	await message({ type: "observer-authorize" }, "browser");
	assert.equal(reads, 0, "declined access must not read files");
	approved = true;
	await message({ type: "observer-authorize" }, "browser");
	assert.deepEqual(sent.at(-1).snapshots, [snapshot]);
	assert.equal(sent.at(-1).coverage.verified, true);
	assert.deepEqual(sent.at(-1).coverage.unobservedPids, [99]);
	snapshot.processInventory.checkedAt = new Date(Date.now() - 31000).toISOString();
	await message({ type: "observer-refresh" }, "browser");
	assert.equal(sent.at(-1).coverage.verified, false, "stale process discovery cannot claim full coverage");
	assert.deepEqual(sent.at(-1).coverage.unobservedPids, []);
	attach("browser"); poll();
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(reads >= 3);
	close(); assert.equal(disposed, 3);
});
