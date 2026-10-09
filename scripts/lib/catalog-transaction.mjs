import { spawnSync } from "node:child_process";
import { linkSync, lstatSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { acquireCatalogLock, atomicWrite, releaseCatalogLock } from "../../adapters/pi/extensions/harness-manager-state.mjs";
import { hashText, isProfileName } from "./web-catalog.mjs";
import { scanText } from "../secret-scan.mjs";
import { planCatalogValidation } from "./catalog-validation.mjs";

import { ENGINE, assertCatalog } from "./repo.mjs";

function runHarness(repo, args, timeout = 600_000, engine = ENGINE) {
	const env = { ...process.env, HARNESS_CATALOG: repo, PI_OFFLINE: "1" };
	delete env.PI_CODING_AGENT_DIR;
	const result = spawnSync(process.execPath, [join(engine, "scripts", "harness.mjs"), ...args], {
		cwd: repo, env, encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024,
	});
	return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr || result.error?.message || "" };
}

function compact(result) {
	const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
	return text.length > 20_000 ? `${text.slice(0, 20_000)}\n… output truncated` : text;
}

function allowedSource(repo, source, format) {
	const absolute = resolve(source);
	if (format === "markdown") {
		const root = resolve(repo, "instructions");
		return absolute.startsWith(`${root}/`) && /^(mandatory|repository|profile)\/[a-z0-9][a-z0-9_-]*(\.(brief|detailed))?\.md$/.test(absolute.slice(root.length + 1));
	}
	return absolute === resolve(repo, "instructions", "selection.json")
		|| (dirname(absolute) === resolve(repo, "profiles") && absolute.endsWith(".json") && isProfileName(basename(absolute, ".json")));
}

function sourceText(repo, source) {
	const canonical = join(realpathSync(repo), relative(resolve(repo), resolve(source)));
	if (realpathSync(dirname(source)) !== dirname(canonical)) throw Object.assign(new Error("Catalog source must resolve to its declared repository path."), { status: 400 });
	try {
		if (!lstatSync(source).isFile()) throw Object.assign(new Error("Catalog source must be a regular file, not a symlink."), { status: 400 });
		return readFileSync(source, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

function replaceSource(repo, source, expected, next) {
	if (sourceText(repo, source) !== expected) throw Object.assign(new Error("配置已被其他管理器修改，操作已停止。请刷新后重试。"), { status: 409 });
	if (next === null) return unlinkSync(source);
	if (expected !== null) return atomicWrite(source, next, `${process.pid}-web`, expected);
	const temporary = `${source}.tmp-${process.pid}-create`;
	writeFileSync(temporary, next, { flag: "wx", mode: 0o600 });
	try { linkSync(temporary, source); }
	catch (error) {
		if (error.code === "EEXIST") error.status = 409;
		throw error;
	} finally { unlinkSync(temporary); }
}

function validateCatalog(repo, plan, recovery = false, engine = ENGINE) {
	const logs = [];
	for (const { name, args, timeout } of plan.steps) {
		const started = Date.now();
		const result = runHarness(repo, args, timeout, engine);
		logs.push({ name: recovery ? `${name} rollback` : name, code: result.code, output: compact(result), durationMs: Date.now() - started });
		if (result.code !== 0 && !recovery) break;
	}
	return logs;
}

/** Save a Catalog JSON object with hash CAS and verified rollback. */
export function applyCatalogJson(options) {
	return applyCatalogSource({ ...options, format: "json", operation: "update" });
}

/** Save one complete instruction variant; all sessions sharing it are affected. */
export function applyCatalogMarkdown(options) {
	return applyCatalogSource({ ...options, format: "markdown", operation: "update" });
}

/** Create a new Profile without overwriting existing sources; validation failure removes it. */
export function createCatalogProfile({ repo, name, value, engine = ENGINE }) {
	if (!isProfileName(name)) return { ok: false, status: 400, error: "方案 ID 格式不正确或使用了保留名称。" };
	return applyCatalogSource({ repo, engine, source: join(repo, "profiles", `${name}.json`), value, format: "json", operation: "create" });
}

/** Delete one existing Profile using its source hash; keep a backup and restore on failure. */
export function deleteCatalogProfile({ repo, name, expectedHash, engine = ENGINE }) {
	if (!isProfileName(name)) return { ok: false, status: 400, error: "方案 ID 格式不正确或使用了保留名称。" };
	return applyCatalogSource({ repo, engine, source: join(repo, "profiles", `${name}.json`), expectedHash, format: "json", operation: "delete" });
}

function applyCatalogSource({ repo, source, expectedHash, value, format, operation, engine = ENGINE }) {
	const started = Date.now();
	try { assertCatalog(repo); } catch (error) { return { ok: false, status: 400, error: error.message }; }
	if (!allowedSource(repo, source, format)) return { ok: false, status: 400, error: "source is outside the editable Catalog boundary" };
	const validValue = operation === "delete" || (format === "markdown" ? typeof value === "string" && value.trim().length > 0
		: value && typeof value === "object" && !Array.isArray(value));
	if ((operation !== "create" && !/^[a-f0-9]{64}$/.test(expectedHash ?? "")) || !validValue) {
		return { ok: false, status: 400, error: "A source hash and a Catalog object are required." };
	}
	const written = operation === "delete" ? null : format === "markdown" ? `${value.trim()}\n` : `${JSON.stringify(value, null, 2)}\n`;
	if (written !== null && scanText(source, written).length) return { ok: false, status: 400, error: "Credential-shaped content was rejected before writing. Use environment variables or native credential storage." };
	let lock;
	let catalogLock;
	let original;
	let backup;
	let sourceWritten = false;
	let logs = [];
	let plan;
	try {
		catalogLock = acquireCatalogLock(join(repo, ".catalog"));
		sourceText(repo, source);
		lock = acquireCatalogLock(source);
		original = sourceText(repo, source);
		if (operation === "create") {
			const collision = readdirSync(dirname(source)).some((file) => file.toLowerCase() === basename(source).toLowerCase());
			if (original !== null || collision) return { ok: false, status: 409, error: "该方案 ID 已存在，请使用其他 ID。" };
		} else {
			if (original === null) return { ok: false, status: 404, error: "方案或指令已不存在。请刷新配置列表。" };
			if (hashText(original) !== expectedHash) return { ok: false, status: 409, error: "配置已被其他管理器修改。请刷新并确认最新内容。" };
		}
		if (operation === "delete") {
			const profiles = readdirSync(dirname(source)).filter((file) => file.endsWith(".json") && isProfileName(basename(file, ".json")));
			if (profiles.length <= 1) return { ok: false, status: 400, error: "至少需要保留一个配置方案，不能删除最后一个方案。" };
		}
		plan = planCatalogValidation({ repo, source, before: original, after: written });
		if (original === written) return { ok: true, status: 200, sourceHash: hashText(written), logs: [], validation: { kind: "unchanged", full: false }, durationMs: Date.now() - started };
		backup = join(tmpdir(), `harness-web-${basename(source)}-${Date.now()}-${process.pid}.bak`);
		writeFileSync(backup, original ?? JSON.stringify({ source, existed: false }), { mode: 0o600, flag: "wx" });
		replaceSource(repo, source, original, written);
		sourceWritten = true;
		logs = validateCatalog(repo, plan, false, engine);
		const failed = logs.find((stage) => stage.code !== 0);
		if (failed) throw Object.assign(new Error(`${failed.name} 检查失败。`), { status: 422 });
		if (sourceText(repo, source) !== written) throw Object.assign(new Error("检查期间配置被其他程序修改。"), { status: 409 });
		return { ok: true, status: operation === "create" ? 201 : 200, sourceHash: written === null ? null : hashText(written), backup, logs,
			validation: { kind: plan.kind, runtime: plan.runtime, full: false }, durationMs: Date.now() - started };
	} catch (error) {
		let recovery = "";
		let rollbackVerified;
		let status = error.status ?? (error.code === "ELOCKED" ? 423 : error.code === "ECHANGED" ? 409 : 500);
		if (sourceWritten) {
			try {
				if (sourceText(repo, source) !== written) {
					status = 409;
					recovery = " 检测到并发修改，未覆盖对方内容。请检查备份后恢复。";
				} else {
					replaceSource(repo, source, written, original);
					const recoveryPlan = planCatalogValidation({ repo, source, before: written, after: original });
					const results = validateCatalog(repo, recoveryPlan, true, engine);
					logs.push(...results);
					rollbackVerified = results.every((result) => result.code === 0);
					recovery = rollbackVerified ? " 已恢复原配置并通过检查。" : " 已恢复源码，但恢复检查失败。请运行 harness doctor。";
				}
			} catch { recovery = " 自动恢复未完成，请检查备份并运行 harness doctor。"; }
		}
		return { ok: false, status, error: `${error.message ?? String(error)}${recovery}`, backup, logs, rollbackVerified, durationMs: Date.now() - started };
	} finally {
		try { if (lock) releaseCatalogLock(lock); }
		finally { if (catalogLock) releaseCatalogLock(catalogLock); }
	}
}

/** Run doctor under the same Catalog lock used by mutation transactions. */
export function runCatalogDoctor(repo, engine = ENGINE) {
	let lock;
	try { lock = acquireCatalogLock(join(repo, ".catalog")); }
	catch (error) { return { ok: false, status: error?.code === "ELOCKED" ? 423 : 500, error: error instanceof Error ? error.message : String(error) }; }
	try {
		const result = runHarness(repo, ["doctor"], 600_000, engine);
		return { ok: result.code === 0, status: result.code === 0 ? 200 : 422, output: compact(result) };
	} finally { releaseCatalogLock(lock); }
}
