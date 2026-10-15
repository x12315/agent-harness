import { homedir } from "node:os";
import { join } from "node:path";

const POLL_INTERVAL_MS = 15_000;
const SNAPSHOT_MAX_AGE_MS = 90_000;
const SUMMARY_MAX_AGE_MS = 60 * 60 * 1000;
const MAX_FILES = 128;
const MAX_FILE_BYTES = 64 * 1024;
const ACCESS_PREFERENCE_KEY = "observer-directory-access";

const observerDirectory = process.env.PI_OBSERVER_DIR || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "observer");

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recent(timestamp, maxAge = SNAPSHOT_MAX_AGE_MS) {
	const time = Date.parse(timestamp || "");
	return Number.isFinite(time) && Date.now() - time <= maxAge;
}

function parseSnapshot(text) {
	try {
		const value = JSON.parse(text);
		if (!isRecord(value) || typeof value.id !== "string" || typeof value.pid !== "number" || !recent(value.updatedAt)) return null;
		return value;
	} catch {
		return null;
	}
}

function parseSummary(text) {
	try {
		const value = JSON.parse(text);
		if (!isRecord(value) || value.scope !== "session" || typeof value.id !== "string" || typeof value.text !== "string" || !recent(value.reportedAt, SUMMARY_MAX_AGE_MS)) return null;
		return value;
	} catch {
		return null;
	}
}

function globalSummary(snapshots, coverage) {
	const active = snapshots.filter((snapshot) => snapshot.active && !snapshot.compaction?.active);
	const compacting = snapshots.filter((snapshot) => snapshot.compaction?.active).length;
	const pending = snapshots.filter((snapshot) => snapshot.attention).length;
	const phases = new Map();
	for (const snapshot of active) {
		const phase = String(snapshot.phase || "working").slice(0, 80);
		phases.set(phase, (phases.get(phase) || 0) + 1);
	}
	const detail = [...phases].slice(0, 4).map(([phase, count]) => `${phase}：${count}`).join("、");
	const missing = coverage.unobservedPids.length;
	const scope = missing ? `；另有 ${missing} 个 Pi 进程未接入，状态未知`
		: coverage.verified ? "" : "；未接入进程尚未核验";
	return {
		scope: "global",
		reportedAt: new Date().toISOString(),
		text: `已接入 ${snapshots.length} 个会话，${active.length} 个正在工作${detail ? `（${detail}）` : ""}，${snapshots.length - active.length - compacting} 个空闲${compacting ? `，${compacting} 个自动压缩中（不计工作耗时）` : ""}${pending ? `；${pending} 个待你处理` : ""}${scope}。`,
	};
}

async function collect(host) {
	const entries = await host.fs.listPath(observerDirectory);
	const files = entries.filter((entry) => entry.type === "file").slice(0, MAX_FILES);
	const snapshots = [];
	const summaries = [];

	for (const entry of files) {
		if (!entry.name.endsWith(".snapshot.json") && !entry.name.endsWith(".summary.json")) continue;
		try {
			const text = await host.fs.readTextPath(join(observerDirectory, entry.name), MAX_FILE_BYTES);
			const parsed = entry.name.endsWith(".snapshot.json") ? parseSnapshot(text) : parseSummary(text);
			if (!parsed) continue;
			if (entry.name.endsWith(".snapshot.json")) snapshots.push(parsed);
			else summaries.push(parsed);
		} catch {
			// Another Pi process can replace or remove an atomic snapshot between list and read.
		}
	}

	snapshots.sort((a, b) => Number(b.active) - Number(a.active) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
	summaries.sort((a, b) => Date.parse(b.reportedAt) - Date.parse(a.reportedAt));
	const inventory = snapshots.map((snapshot) => snapshot.processInventory)
		.filter((value) => isRecord(value) && recent(value.checkedAt, POLL_INTERVAL_MS * 2) && Array.isArray(value.pids) && value.pids.length <= 256)
		.sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))[0];
	const observedPids = new Set(snapshots.map((snapshot) => snapshot.pid));
	const unobservedPids = inventory
		? [...new Set(inventory.pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0 && !observedPids.has(pid)))]
		: [];
	const coverage = { verified: !!inventory, checkedAt: inventory?.checkedAt || null, unobservedPids };
	return {
		snapshots,
		summary: globalSummary(snapshots, coverage),
		summaries: summaries.filter((summary) => snapshots.some((snapshot) => snapshot.id === summary.id)),
		coverage,
	};
}

export default {
	async activate(host) {
		const savedAccess = host.storage?.get(ACCESS_PREFERENCE_KEY);
		let rememberAccess = isRecord(savedAccess) && savedAccess.schemaVersion === 1 && savedAccess.directory === observerDirectory && savedAccess.remember === true;
		let authorized = rememberAccess;
		let accessError;
		let authorizationPending;
		let disposed = false;
		const savePreference = (remember) => {
			host.storage.set(ACCESS_PREFERENCE_KEY, { schemaVersion: 1, directory: observerDirectory, remember });
			rememberAccess = remember;
		};

		const state = async () => {
			if (!authorized) {
				return {
					type: "observer-state",
					authorized: false,
					rememberAccess,
					error: accessError,
					directory: observerDirectory,
					snapshots: [],
					summary: null,
					summaries: [],
					refreshedAt: new Date().toISOString(),
				};
			}
			try {
				return { type: "observer-state", authorized: true, rememberAccess, error: accessError, directory: observerDirectory, ...(await collect(host)), refreshedAt: new Date().toISOString() };
			} catch {
				authorized = false;
				accessError = "目录当前不可访问；可能是宿主授权已撤销或目录不存在，请检查后重新确认。记忆选项不会绕过宿主权限。";
				return {
					type: "observer-state",
					authorized: false,
					rememberAccess,
					directory: observerDirectory,
					snapshots: [],
					summary: null,
					summaries: [],
					error: accessError,
					refreshedAt: new Date().toISOString(),
				};
			}
		};

		const publish = async (clientId) => {
			if (disposed) return;
			const payload = await state();
			if (disposed) return;
			if (clientId) host.sendTo(clientId, payload);
			else host.broadcast(payload);
		};

		const offMessage = host.onMessage(async (payload, clientId) => {
			if (!isRecord(payload) || typeof payload.type !== "string") return;
			if (disposed) return;
			if (payload.type === "observer-authorize") {
				if (!authorizationPending) {
					authorizationPending = (async () => {
						accessError = undefined;
						try {
							const approved = await host.fs.requestAccess(observerDirectory, "Read Pi Observer snapshots for the Observer tab.");
							if (disposed) return;
							authorized = approved === true;
							if (authorized && (host.storage || payload.remember === true)) savePreference(payload.remember === true);
						} catch { accessError = "无法请求或保存访问授权；请重试。"; }
					})().finally(() => { authorizationPending = undefined; });
				}
				await authorizationPending;
			}
			if (payload.type === "observer-remember-access" && typeof payload.remember === "boolean") {
				try {
					if (!payload.remember || authorized) { savePreference(payload.remember); accessError = undefined; }
					else accessError = "请先允许读取当前目录，再记住访问授权。";
				} catch { accessError = "无法保存记忆选项；请重试。"; }
			}
			if (["observer-authorize", "observer-remember-access", "observer-refresh", "observer-get"].includes(payload.type)) {
				await publish(clientId);
			}
		});
		const offAttach = host.onAttach((clientId) => void publish(clientId));
		const stopPolling = host.schedule(POLL_INTERVAL_MS, () => void publish(), { label: "Pi Observer refresh" });

		host.log("Pi Observer tab activated", observerDirectory);
		return () => {
			disposed = true;
			offMessage();
			offAttach();
			stopPolling();
		};
	},
};
