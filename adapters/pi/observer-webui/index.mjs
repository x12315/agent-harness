import { homedir } from "node:os";
import { join } from "node:path";
import {
	CONTROL_ACTIONS,
	SCHEMA,
	appendEvent,
	capability,
	controlRequest,
	discrepancies,
	enqueueControl,
	listControls,
	orderFrames,
	readControl,
	readEvents,
	readTaskFacts,
	sessionFrame,
	taskFrame,
} from "./protocol.generated.mjs";

const POLL_INTERVAL_MS = 15_000;
const SNAPSHOT_MAX_AGE_MS = 90_000;
const SUMMARY_MAX_AGE_MS = 60 * 60 * 1000;
const MAX_FILES = 128;
const MAX_FILE_BYTES = 64 * 1024;
const ACCESS_PREFERENCE_KEY = "observer-directory-access";
const VIEW_SCHEMA = "observer.view/1";
/** Only pi-coordinator consumes the control queue; Observer never applies it itself. */
const CONTROL_OWNER = "pi-coordinator";
const OWNED_CONTROL_ACTIONS = Object.freeze(["pause", "resume", "cancel"]);
const CONTROL_BODY_LIMIT = 8 * 1024;
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,120}$/;
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const observerDirectory = process.env.PI_OBSERVER_DIR || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "observer");
/** Task facts, control requests and the event journal share the observation root. */
const controlRoot = observerDirectory;

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

async function collectSnapshots(host) {
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

const emptyCoverage = () => ({ verified: false, checkedAt: null, unobservedPids: [] });
const controlEnabled = (settings) => settings?.allowControl === true;
const advertisedActions = (settings) => controlEnabled(settings) ? [...OWNED_CONTROL_ACTIONS] : [];

function capabilityFor(settings, coverage) {
	// Actions are advertised only when this instance can queue them, and only
	// because CONTROL_OWNER consumes them; Observer itself never applies control.
	return capability({
		sources: ["pi-session", "webui-task"],
		actions: advertisedActions(settings),
		transports: ["http"],
		coverage,
	});
}

function emptyView(settings, coverage = emptyCoverage()) {
	return {
		viewSchema: VIEW_SCHEMA,
		frames: [],
		tasks: [],
		capability: capabilityFor(settings, coverage),
		discrepancies: discrepancies({ frames: [], controls: [], coverage }),
		controlRoot,
	};
}

/**
 * Read the additive protocol view. Session frames come from the same bounded
 * snapshots the tab already uses; task frames come from owner-published facts.
 * `strict` is for HTTP callers, which must see a stable 503 instead of a
 * silently narrowed view when the protocol filesystem is unreadable.
 */
async function buildView({ snapshots, summaries, coverage, settings, now = Date.now(), strict = false }) {
	const summaryById = new Map();
	for (const summary of summaries) if (!summaryById.has(summary.id)) summaryById.set(summary.id, summary);
	const sessionFrames = snapshots
		.map((snapshot) => sessionFrame(snapshot, { now, summary: summaryById.get(snapshot.id) }))
		.filter(Boolean);
	let tasks = [];
	try {
		tasks = await readTaskFacts(controlRoot, { now });
	} catch (error) {
		if (strict) throw error;
	}
	let controls = [];
	try {
		controls = await listControls(controlRoot);
	} catch (error) {
		if (strict) throw error;
	}
	const frames = orderFrames([...sessionFrames, ...tasks.map((fact) => taskFrame(fact, { now })).filter(Boolean)]);
	return {
		viewSchema: VIEW_SCHEMA,
		frames,
		tasks,
		capability: capabilityFor(settings, coverage),
		discrepancies: discrepancies({ frames, controls, coverage, now }),
		controlRoot,
	};
}

function isLoopback(request) {
	const address = request?.socket?.remoteAddress;
	return typeof address === "string" && LOOPBACK_ADDRESSES.has(address);
}

function validIdentifier(value) {
	return typeof value === "string" && IDENTIFIER.test(value) && !value.includes("..");
}

function isPiSessionTarget(value) {
	return isRecord(value)
		&& (value.schemaVersion === undefined || value.schemaVersion === SCHEMA.control)
		&& isRecord(value.target)
		&& validIdentifier(value.target.subjectId)
		&& value.target.taskRef === undefined
		&& CONTROL_ACTIONS.includes(value.action)
		&& (value.commandId === undefined || validIdentifier(value.commandId))
		&& validIdentifier(value.consumerId);
}

function controlIdFromPath(pathname) {
	const parts = String(pathname ?? "").split("/").filter(Boolean);
	const index = parts.lastIndexOf("control");
	return index >= 0 && parts[index + 1] ? decodeURIComponent(parts[index + 1]) : undefined;
}

/**
 * Read a body while bounding what is retained. Once the limit is exceeded the
 * rest is drained but not buffered, so an oversized request still receives a
 * stable 400 instead of tearing down the connection mid-response.
 */
async function readHttpBody(request, limit) {
	if (request?.body !== undefined) {
		const raw = Buffer.isBuffer(request.body)
			? request.body
			: Buffer.from(typeof request.body === "string" ? request.body : JSON.stringify(request.body));
		if (raw.length > limit) throw new RangeError("body too large");
		return raw.toString("utf8");
	}
	if (!request || typeof request[Symbol.asyncIterator] !== "function") throw new TypeError("body is not readable");
	let total = 0;
	let overflow = false;
	const chunks = [];
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += bytes.length;
		if (total > limit) {
			overflow = true;
			chunks.length = 0;
		} else if (!overflow) {
			chunks.push(bytes);
		}
	}
	if (overflow) throw new RangeError("body too large");
	return Buffer.concat(chunks).toString("utf8");
}

export default {
	async activate(host) {
		const savedAccess = host.storage?.get(ACCESS_PREFERENCE_KEY);
		let rememberAccess = isRecord(savedAccess) && savedAccess.schemaVersion === 1 && savedAccess.directory === observerDirectory && savedAccess.remember === true;
		let authorized = rememberAccess;
		let accessError;
		let authorizationPending;
		let disposed = false;
		const settingsNow = () => host.getSettings?.() ?? {};
		const routeDisposers = [];
		const emptyViewFor = () => emptyView(settingsNow());

		const withView = async (legacy) => ({ ...legacy, ...(await buildView({ ...legacy, settings: settingsNow() })) });

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
					coverage: emptyCoverage(),
					...emptyViewFor(),
					refreshedAt: new Date().toISOString(),
				};
			}
			try {
				const legacy = await collectSnapshots(host);
				return { type: "observer-state", authorized: true, rememberAccess, error: accessError, directory: observerDirectory, ...(await withView(legacy)), refreshedAt: new Date().toISOString() };
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
					coverage: emptyCoverage(),
					...emptyViewFor(),
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

		const sendJson = (response, status, value) => {
			if (response.headersSent) return;
			response.statusCode = status;
			response.setHeader("Content-Type", "application/json; charset=utf-8");
			response.setHeader("Cache-Control", "no-store");
			response.end(JSON.stringify(value));
		};
		const sendError = (response, status, error, detail) => {
			sendJson(response, status, detail ? { error, detail } : { error });
		};
		const sendUnavailable = (response) => sendError(response, 503, "unavailable");

		/** Current session evidence for HTTP callers. The host still enforces its own filesystem grant; this plugin never prompts from an HTTP request. */
		const routeInputs = () => collectSnapshots(host);

		const readControlResponse = async (response, commandId) => {
			if (!validIdentifier(commandId)) {
				sendError(response, 400, "invalid-request");
				return;
			}
			try {
				const receipt = await readControl(controlRoot, commandId);
				if (!receipt) sendError(response, 404, "not-found");
				else sendJson(response, 200, receipt);
			} catch {
				sendUnavailable(response);
			}
		};

		const writeRoute = (method, path, handler) => {
			if (typeof host.route !== "function") return;
			try {
				const off = host.route(method, path, (request, response) => {
					if (!isLoopback(request)) {
						sendError(response, 403, "loopback-only");
						return;
					}
					void Promise.resolve(handler(request, response)).catch(() => {
						host.log?.("error", `Observer ${method} ${path} failed`);
						if (!response.headersSent) sendUnavailable(response);
					});
				});
				if (typeof off === "function") routeDisposers.push(off);
			} catch {
				host.log?.("warn", `Observer could not register ${method} ${path}`);
			}
		};

		// Control state is read through the query form so the route table stays fixed:
		// the host matches exact paths and dynamically adding one route per command
		// would grow without bound.

		writeRoute("GET", "/capability", async (_request, response) => {
			let coverage = emptyCoverage();
			try {
				({ coverage } = await routeInputs());
			} catch {
				sendUnavailable(response);
				return;
			}
			sendJson(response, 200, capabilityFor(settingsNow(), coverage));
		});

		writeRoute("GET", "/frames", async (_request, response) => {
			try {
				const legacy = await routeInputs();
				const view = await buildView({ ...legacy, settings: settingsNow(), strict: true });
				sendJson(response, 200, {
					viewSchema: view.viewSchema,
					frames: view.frames,
					tasks: view.tasks,
					discrepancies: view.discrepancies,
					coverage: legacy.coverage,
					controlRoot: view.controlRoot,
					refreshedAt: new Date().toISOString(),
				});
			} catch {
				sendUnavailable(response);
			}
		});

		writeRoute("GET", "/events", async (request, response) => {
			let url;
			try {
				url = new URL(request.url ?? "/events", "http://127.0.0.1");
			} catch {
				sendError(response, 400, "invalid-query");
				return;
			}
			const since = url.searchParams.get("since") ?? undefined;
			const limitRaw = url.searchParams.get("limit");
			if (since !== undefined && (!IDENTIFIER.test(since) || since.includes(".."))) {
				sendError(response, 400, "invalid-query");
				return;
			}
			const limit = limitRaw === null ? 200 : Number(limitRaw);
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000) {
				sendError(response, 400, "invalid-query");
				return;
			}
			try {
				sendJson(response, 200, await readEvents(controlRoot, { since, limit }));
			} catch {
				sendUnavailable(response);
			}
		});

		writeRoute("GET", "/control", async (request, response) => {
			let id;
			try {
				const url = new URL(request.url ?? "/control", "http://127.0.0.1");
				id = url.searchParams.get("id") ?? url.searchParams.get("commandId") ?? controlIdFromPath(url.pathname);
			} catch {
				sendError(response, 400, "invalid-request");
				return;
			}
			await readControlResponse(response, id);
		});

		writeRoute("POST", "/control", async (request, response) => {
			const contentType = String(request.headers?.["content-type"] ?? "").split(";")[0].trim().toLowerCase();
			if (contentType !== "application/json") {
				sendError(response, 400, "invalid-body");
				return;
			}
			let body;
			try {
				body = JSON.parse(await readHttpBody(request, CONTROL_BODY_LIMIT));
			} catch {
				sendError(response, 400, "invalid-request");
				return;
			}
			let validated;
			let subjectOnly = false;
			let invalid = false;
			try {
				validated = controlRequest(body);
			} catch {
				if (isPiSessionTarget(body)) subjectOnly = true;
				else invalid = true;
			}
			if (!controlEnabled(settingsNow())) {
				sendError(response, 403, "control-disabled");
				return;
			}
			if (subjectOnly) {
				sendError(response, 422, "unsupported-action", "Pi sessions advertise no control owner");
				return;
			}
			if (invalid || !validated) {
				sendError(response, 400, "invalid-request");
				return;
			}
			if (validated.target.subjectId && !validated.target.taskRef) {
				sendError(response, 422, "unsupported-action", "Pi sessions advertise no control owner");
				return;
			}
			try {
				const receipt = await enqueueControl(controlRoot, validated);
				if (!receipt.duplicate) {
					try {
						await appendEvent(controlRoot, {
							type: "control.requested",
							...(validated.target.subjectId ? { subjectId: validated.target.subjectId } : {}),
							...(validated.target.taskRef ? { taskRef: validated.target.taskRef } : {}),
							payload: { commandId: validated.commandId, action: validated.action, consumerId: validated.consumerId },
						});
					} catch {
						host.log?.("error", "Observer control request queued but the journal append failed");
					}
				}
				sendJson(response, 202, receipt);
			} catch {
				sendUnavailable(response);
			}
		});

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

		host.log?.("Pi Observer tab activated", observerDirectory);
		host.log?.("info", `Observer control actions are owned by ${CONTROL_OWNER}`);
		return () => {
			disposed = true;
			for (const off of routeDisposers.splice(0).reverse()) {
				try { off(); } catch { /* host effects also remove the same routes */ }
			}
			offMessage();
			offAttach();
			stopPolling();
		};
	},
};
