const KEY = "pi-coordinator-outbox-v1";

/** Persist unsent/unacknowledged requests in the browser tab; retain IDs across reconnects. */
export class Outbox {
	constructor(storage) {
		this.storage = storage;
		const value = JSON.parse(storage.getItem(KEY) || "[]");
		if (!Array.isArray(value) || value.length > 32 || value.some((item) => !item || typeof item.requestId !== "string" || typeof item.text !== "string" || typeof item.workspace !== "string")) throw new Error("Invalid retained outbox");
		this.items = value;
	}
	/** Save before transport submission; failures leave the editor untouched. */
	add(item) {
		if (this.items.length >= 32) throw new Error("Outbox full");
		const next = [...this.items, item];
		this.storage.setItem(KEY, JSON.stringify(next));
		this.items = next;
	}
	/** Only durable server receipts or persisted server snapshots can acknowledge a request. */
	acknowledge(requestId) {
		const next = this.items.filter((item) => item.requestId !== requestId);
		this.storage.setItem(KEY, JSON.stringify(next));
		this.items = next;
	}
	/** Reconcile persisted server inputs, then return matching-workspace requests for safe replay. */
	reconcile(workspace, inputs) {
		for (const item of inputs) if (item.requestId) this.acknowledge(item.requestId);
		return this.items.filter((item) => item.workspace === workspace);
	}
}
