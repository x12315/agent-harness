import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { acquireCatalogLock, releaseCatalogLock } from "../../adapters/pi/extensions/harness-manager-state.mjs";
import { atomicWrite } from "./atomic-write.mjs";
import { CATALOG, ENGINE, HOME } from "./repo.mjs";
import { isProfileName } from "./profile-name.mjs";

const hashText = text => createHash("sha256").update(text).digest("hex");

const MAX_STATE_BYTES = 4096;
const MAX_SOURCE_BYTES = 1024 * 1024;
const validProfile = value => isProfileName(value) && value.length <= 200;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

function entry(path) {
	try { return lstatSync(path); }
	catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function canonicalDirectory(path) {
	if (typeof path !== "string" || !path.trim() || path.includes("\0") || path.length > 4096) fail("目录路径无效。");
	const canonical = realpathSync(resolve(path));
	if (!lstatSync(canonical).isDirectory()) fail("指定路径不是目录。");
	return canonical;
}

function assertParents(ctx) {
	for (const root of [ctx.home, ctx.catalog, ctx.engine]) {
		if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) fail("目录已改变或包含符号链接；请人工核验。");
	}
	const sourceDirectory = entry(ctx.profiles);
	if (sourceDirectory && !sourceDirectory.isDirectory()) fail("方案源码目录不能是符号链接或其他非目录对象。");
	let parent = ctx.home;
	for (const component of relative(ctx.home, ctx.directory).split("/")) {
		parent = join(parent, component);
		const stat = entry(parent);
		if (stat && !stat.isDirectory()) fail("启动偏好目录不能包含符号链接或其他非目录对象。");
	}
}

function context(catalog, home, engine) {
	const ctx = { catalog: canonicalDirectory(catalog), home: canonicalDirectory(home), engine: canonicalDirectory(engine) };
	ctx.profiles = join(ctx.catalog, "profiles");
	ctx.directory = join(ctx.home, ".local/state/harness/startup-profile");
	for (const root of [ctx.catalog, ctx.engine]) {
		const suffix = relative(root, ctx.directory);
		if (suffix !== ".." && !suffix.startsWith("../")) fail("启动偏好不能存放在 Engine 或 Catalog 内。");
	}
	ctx.file = join(ctx.directory, `${hashText(ctx.catalog)}.json`);
	assertParents(ctx);
	return ctx;
}

function readText(path, limit, label) {
	const stat = entry(path);
	if (!stat) return null;
	if (!stat.isFile()) fail(`${label}必须是普通文件，不能是符号链接。`);
	if (stat.size > limit) fail(`${label}超过大小限制。`);
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.size > limit) fail(`${label}必须是大小限制内的普通文件。`);
		const bytes = readFileSync(fd);
		const text = bytes.toString("utf8");
		if (bytes.length > limit || !Buffer.from(text, "utf8").equals(bytes)) fail(`${label}超过大小限制或不是有效 UTF-8 文本。`);
		return text;
	} finally { closeSync(fd); }
}

function jsonObject(text, label) {
	let value;
	try { value = JSON.parse(text); } catch { fail(`${label}不是有效 JSON 对象。`); }
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label}不是有效 JSON 对象。`);
	return value;
}

function readPreference(ctx, result) {
	assertParents(ctx);
	const text = readText(ctx.file, MAX_STATE_BYTES, "启动偏好文件");
	result.preferencesHash = hashText(text ?? "missing");
	if (text === null) {
		result.profile = null;
		result.missing = false;
		return text;
	}
	const value = jsonObject(text, "启动偏好文件");
	if (value.schemaVersion !== 1 || Object.keys(value).length !== 2 || !Object.hasOwn(value, "profile")
		|| (value.profile !== null && !validProfile(value.profile))) fail("启动偏好格式无效；仅接受 schemaVersion: 1 和有效的 profile。");
	result.profile = value.profile;
	result.missing = false;
	return text;
}

function profileMissing(ctx, profile) {
	assertParents(ctx);
	if (profile === null) return false;
	const text = readText(join(ctx.profiles, `${profile}.json`), MAX_SOURCE_BYTES, "方案源码");
	if (text === null) return true;
	jsonObject(text, "方案源码");
	return false;
}

function createStateDirectory(ctx) {
	let parent = ctx.home;
	for (const component of relative(ctx.home, ctx.directory).split("/")) {
		assertParents(ctx);
		parent = join(parent, component);
		if (!entry(parent)) mkdirSync(parent, { mode: 0o700 });
	}
	assertParents(ctx);
}

/** Read or configure the local default Pi startup Profile for a canonical Catalog.
 * null selects ordinary mode; a named Profile must have a safe, regular JSON object source.
 * Missing selected sources remain selected with missing=true. Invalid state fails closed.
 * Status is read-only. Configure requires preferencesHash (SHA-256 of exact saved UTF-8 text,
 * or SHA-256 of "missing" when absent) and uses the Catalog transaction/source locks plus
 * a preference-file lock and atomic byte CAS. Only private local state is persisted;
 * Catalog sources, native settings, auth and the current runtime are never modified.
 */
export function runStartupProfile({ operation = "status", profile, expectedHash, catalog = CATALOG, home = HOME, engine = ENGINE } = {}) {
	const result = { ok: true, status: 200, profile: null, preferencesHash: null, missing: false };
	const locks = [];
	try {
		if (!["status", "configure"].includes(operation)) fail("未知启动偏好操作。");
		if (operation === "configure") {
			if (profile !== null && !validProfile(profile)) fail("请明确选择普通模式（null）或有效方案 ID；不能使用保留名称。");
			if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash)) fail("请提供有效的启动偏好版本哈希。");
		}
		const ctx = context(catalog, home, engine);
		let original = readPreference(ctx, result);
		if (operation === "status") {
			result.missing = profileMissing(ctx, result.profile);
			return result;
		}
		if (expectedHash !== result.preferencesHash) fail("启动偏好已被其他管理器修改；请刷新后重试。", 409);
		if (profileMissing(ctx, profile)) fail("所选方案已不存在；请刷新方案列表。", 404);
		locks.push(acquireCatalogLock(join(ctx.catalog, ".catalog")));
		assertParents(ctx);
		if (profile !== null) locks.push(acquireCatalogLock(join(ctx.profiles, `${profile}.json`)));
		createStateDirectory(ctx);
		locks.push(acquireCatalogLock(ctx.file));
		original = readPreference(ctx, result);
		if (expectedHash !== result.preferencesHash) fail("启动偏好已被其他管理器修改；请刷新后重试。", 409);
		const text = `${JSON.stringify({ schemaVersion: 1, profile }, null, 2)}\n`;
		atomicWrite(ctx.file, text, `${process.pid}-startup-profile-${randomUUID()}`, original, () => {
			assertParents(ctx);
			readText(ctx.file, MAX_STATE_BYTES, "启动偏好文件");
			if (profileMissing(ctx, profile)) fail("所选方案已不存在；请刷新方案列表。", 404);
		});
		result.profile = profile;
		result.preferencesHash = hashText(text);
		result.missing = false;
		return result;
	} catch (error) {
		return { ...result, ok: false, status: error.code === "ELOCKED" ? 423 : error.code === "ECHANGED" ? 409 : error.status ?? 500,
			error: error.status ? error.message : error.code === "ELOCKED" ? "启动偏好或方案正由其他管理器操作；请稍后重试。"
				: error.code === "ECHANGED" ? "启动偏好在写入前发生变化；未覆盖其他程序的修改。" : "无法读取或保存启动偏好；请人工核验目录、文件和权限。" };
	} finally {
		for (const lock of locks.reverse()) {
			try {
				const parent = dirname(lock.path);
				if (realpathSync(parent) === parent) releaseCatalogLock(lock);
				else closeSync(lock.fd);
			} catch { try { closeSync(lock.fd); } catch { /* Keep lock evidence if its parent changed. */ } }
		}
	}
}
