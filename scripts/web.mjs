#!/usr/bin/env node
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fork, spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { isProfileName, readCatalog } from "./lib/web-catalog.mjs";
import { ENGINE, REPO, assertCatalog } from "./lib/repo.mjs";

const MIME_TYPES = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".svg": "image/svg+xml",
};

function safeEqual(left, right) {
	const a = Buffer.from(left ?? "");
	const b = Buffer.from(right ?? "");
	return a.length === b.length && timingSafeEqual(a, b);
}

function cookieToken(request, cookieName) {
	for (const part of (request.headers.cookie ?? "").split(";")) {
		const [name, ...value] = part.trim().split("=");
		if (name === cookieName) {
			try { return decodeURIComponent(value.join("=")); }
			catch { return ""; }
		}
	}
	return "";
}

function json(response, status, value) {
	const body = `${JSON.stringify(value)}\n`;
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
		"Cache-Control": "no-store",
	});
	response.end(body);
}

async function requestJson(request, limit = 2 * 1024 * 1024) {
	if (Number(request.headers["content-length"]) > limit) {
		request.resume();
		throw Object.assign(new Error("request body is too large"), { status: 413 });
	}
	let size = 0;
	const chunks = [];
	for await (const chunk of request) {
		size += chunk.length;
		if (size > limit) throw Object.assign(new Error("request body is too large"), { status: 413 });
		chunks.push(chunk);
	}
	try {
		const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
		return value;
	} catch {
		throw Object.assign(new Error("request body must be valid JSON"), { status: 400 });
	}
}

function modelMetadata() {
	const env = { ...process.env, PI_OFFLINE: "1" };
	delete env.PI_CODING_AGENT_DIR;
	const result = spawnSync("pi", [
		"--offline", "--no-extensions", "--extension", join(ENGINE, "scripts/probes/pi-web-models.ts"),
		"--no-context-files", "--no-skills", "--no-tools", "--no-session", "--mode", "rpc",
	], {
		env,
		cwd: REPO,
		input: `${JSON.stringify({ id: "models", type: "prompt", message: "/harness-web-models" })}\n`,
		encoding: "utf8", timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
	});
	for (const line of (result.stdout ?? "").split("\n")) {
		try {
			const event = JSON.parse(line);
			if (event.type === "extension_ui_request" && event.method === "notify") return JSON.parse(event.message);
		} catch { /* Ignore unrelated RPC events. */ }
	}
	return [];
}

function modelOutput() {
	const result = spawnSync("pi", ["--offline", "--list-models"], {
		env: { ...process.env, PI_OFFLINE: "1" },
		encoding: "utf8",
		timeout: 15_000,
		maxBuffer: 1024 * 1024,
	});
	return result.status === 0 ? result.stdout : "";
}

function parseScopeModels(raw) {
	if (!raw) return [];
	try {
		const value = JSON.parse(raw);
		return Array.isArray(value)
			? value.filter((entry) => entry && typeof entry.provider === "string" && typeof entry.id === "string")
			: [];
	} catch {
		return [];
	}
}

async function openBrowser(url) {
	const candidates = process.platform === "darwin"
		? [["/usr/bin/open", [url]]]
		: process.platform === "win32"
			? [["cmd.exe", ["/c", "start", "", url]]]
			: [["/usr/bin/xdg-open", [url]], ["xdg-open", [url]]];
	for (const [command, args] of candidates) {
		if (command.startsWith("/") && !existsSync(command)) continue;
		try {
			const child = spawn(command, args, { detached: true, stdio: "ignore" });
			const started = await new Promise((resolveStarted) => {
				child.once("error", () => resolveStarted(false));
				child.once("exit", (code) => resolveStarted(code === 0));
			});
			child.unref();
			if (started) return true;
		} catch {
			// Try the next platform launcher.
		}
	}
	return false;
}

function webRoot(repo) {
	return join(repo, "web");
}

function serveStatic(pathname, response) {
	const route = pathname === "/" ? "/index.html" : pathname;
	if (!/^\/(?:index\.html|styles\.css|app\.js)$/.test(route)) return false;
	const root = webRoot(ENGINE);
	const file = resolve(root, `.${route}`);
	if (!file.startsWith(`${resolve(root)}/`) || !existsSync(file) || !statSync(file).isFile()) return false;
	response.writeHead(200, {
		"Content-Type": MIME_TYPES[extname(file)] ?? "application/octet-stream",
		"Content-Length": statSync(file).size,
		"Cache-Control": "no-cache",
	});
	createReadStream(file).pipe(response);
	return true;
}

function runCatalogWorker(message) {
	return new Promise((resolveWorker, reject) => {
		const worker = fork(join(ENGINE, "scripts/lib/catalog-worker.mjs"), [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
		let replied = false;
		worker.once("message", (result) => { replied = true; resolveWorker(result); });
		worker.once("error", reject);
		worker.once("exit", (code) => {
			if (!replied) reject(new Error(`Catalog worker exited ${code}. Check the source lock and backup before retrying.`));
		});
		worker.send(message);
	});
}

/** Start an authenticated, loopback-only workbench. Returns server/closed for callers to stop it.
 * options.repo selects a read/write Catalog; modelOutput/models are credential-free test inputs.
 * No model turns are sent. All mutations run in workers sharing the Catalog transaction lock.
 */
export async function startHarnessWeb(options = {}) {
	const repo = resolve(options.repo ?? REPO);
	assertCatalog(repo);
	const engine = options.engine ?? ENGINE;
	const invokeWorker = (message) => runCatalogWorker({ ...message, engine, ...(message.options ? { options: { ...message.options, engine } } : {}) });
	const host = "127.0.0.1";
	const port = Number(options.port ?? 0);
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Web port must be an integer from 0 to 65535.");
	const token = options.token ?? randomBytes(24).toString("base64url");
	const scopeModels = options.scopeModels ?? parseScopeModels(process.env.HARNESS_MODEL_SCOPE);
	let cachedModelOutput = options.modelOutput;
	let cachedModels = options.models;
	let server;
	const startedAt = new Date().toISOString();

	const handler = async (request, response) => {
		const address = server.address();
		const origin = `http://${host}:${address.port}`;
		let url;
		try { url = new URL(request.url ?? "/", origin); }
		catch { json(response, 400, { ok: false, error: "Invalid request URL." }); return; }
		const cookieName = `harness_web_${address.port}`;
		if (request.headers.host !== `${host}:${address.port}`) {
			json(response, 403, { ok: false, error: "Unexpected Host header." });
			return;
		}
		const headers = {
			"Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
			"Cross-Origin-Opener-Policy": "same-origin",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
			"X-Frame-Options": "DENY",
		};
		for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);

		if (url.pathname === "/" && url.searchParams.has("token")) {
			if (!safeEqual(url.searchParams.get("token"), token)) {
				response.writeHead(401).end("Invalid Harness Web token");
				return;
			}
			response.setHeader("Set-Cookie", `${cookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`);
			response.writeHead(303, { Location: "/" }).end();
			return;
		}

		if (url.pathname.startsWith("/api/")) {
			if (!safeEqual(cookieToken(request, cookieName), token)) {
				json(response, 401, { ok: false, error: "Harness Web authorization is required." });
				return;
			}
			if ((request.headers.origin && request.headers.origin !== origin) || (request.headers["sec-fetch-site"] && !["same-origin", "none"].includes(request.headers["sec-fetch-site"]))) {
				json(response, 403, { ok: false, error: "Cross-origin requests are not allowed." });
				return;
			}
			if (request.method === "POST" && (request.headers.origin !== origin || !request.headers["content-type"]?.startsWith("application/json"))) {
				json(response, 403, { ok: false, error: "Write requests require the local Origin and application/json." });
				return;
			}
			try {
				if (request.method === "GET" && url.pathname === "/api/catalog") {
					cachedModels ??= options.modelOutput === undefined ? modelMetadata() : [];
					cachedModelOutput ??= cachedModels.length ? "" : modelOutput();
					json(response, 200, { ok: true, repo, startedAt, ...readCatalog(repo, { modelOutput: cachedModelOutput, models: cachedModels, scopeModels }) });
					return;
				}
				if (request.method === "POST" && ["/api/create-profile", "/api/delete-profile"].includes(url.pathname)) {
					const body = await requestJson(request);
					if (!isProfileName(body.name)) throw Object.assign(new Error("方案 ID 格式不正确或使用了保留名称。"), { status: 400 });
					const result = await invokeWorker({ action: url.pathname.slice("/api/".length), options: {
						repo, name: body.name, value: body.value, expectedHash: body.expectedHash,
					} });
					json(response, result.status, result);
					return;
				}
				if (request.method === "POST" && url.pathname === "/api/save-profile") {
					const body = await requestJson(request);
					if (!isProfileName(body.name)) throw Object.assign(new Error("invalid profile name"), { status: 400 });
					const result = await invokeWorker({ action: "save", options: {
						repo,
						source: join(repo, "profiles", `${body.name}.json`),
						expectedHash: body.expectedHash,
						value: body.value,
					} });
					json(response, result.status, result);
					return;
				}
				if (request.method === "POST" && url.pathname === "/api/save-instructions") {
					const body = await requestJson(request);
					const result = await invokeWorker({ action: "save", options: {
						repo,
						source: join(repo, "instructions", "selection.json"),
						expectedHash: body.expectedHash,
						value: body.value,
					} });
					json(response, result.status, result);
					return;
				}
				if (request.method === "POST" && url.pathname === "/api/save-instruction-text") {
					const body = await requestJson(request);
					if (!/^(mandatory|repository|profile)\/[a-z0-9][a-z0-9_-]*$/.test(body.id ?? "") || !["brief", "standard", "detailed"].includes(body.detail)) {
						json(response, 400, { ok: false, error: "Invalid instruction or variant." });
						return;
					}
					const suffix = body.detail === "standard" ? "" : `.${body.detail}`;
					const result = await invokeWorker({ action: "save-markdown", options: {
						repo, source: join(repo, "instructions", `${body.id}${suffix}.md`), expectedHash: body.expectedHash, value: body.text,
					} });
					json(response, result.status, result);
					return;
				}
				if (request.method === "POST" && url.pathname === "/api/doctor") {
					const result = await invokeWorker({ action: "doctor", repo });
					json(response, result.status, result);
					return;
				}
				if (request.method === "POST" && url.pathname === "/api/shutdown") {
					json(response, 200, { ok: true });
					setTimeout(() => server.close(), 50).unref();
					return;
				}
				json(response, 404, { ok: false, error: "Unknown Harness Web API route." });
			} catch (error) {
				json(response, error?.status ?? 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}

		if (request.method === "GET" && serveStatic(url.pathname, response)) return;
		response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found\n");
	};

	server = createServer(handler);
	server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
	await new Promise((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(port, host, resolveListen);
	});
	const address = server.address();
	const url = `http://${host}:${address.port}/?token=${encodeURIComponent(token)}`;
	return {
		server,
		repo,
		url,
		origin: `http://${host}:${address.port}`,
		token,
		closed: new Promise((resolveClosed) => server.once("close", resolveClosed)),
	};
}

/** CLI lifecycle: print the ephemeral authorization URL, optionally open it, and await shutdown. */
export async function runHarnessWeb(options = {}) {
	const instance = await startHarnessWeb(options);
	process.stdout.write(`Harness Web: ${instance.url}\n`);
	if (options.open !== false && !await openBrowser(instance.url)) process.stdout.write("Open the URL above in a local browser.\n");
	const shutdown = () => instance.server.close();
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	await instance.closed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const portArg = process.argv.find((argument) => argument.startsWith("--port="));
	await runHarnessWeb({
		port: portArg ? Number(portArg.slice("--port=".length)) : 0,
		open: !process.argv.includes("--no-open"),
	});
}
