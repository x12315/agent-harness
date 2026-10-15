import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { atomicWrite } from "./atomic-write.mjs";
import { managedLinks, projectionSource } from "./repo.mjs";
import { verificationEnvironment } from "./check-runner.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const fail = message => { throw Object.assign(new Error(message), { status: 409 }); };
const generated = path => path === "AGENTS.md" || path === "profiles/profile.schema.json" || /^adapters\/(?:pi|codex)\/profiles\/[^/]+\.(?:json|config\.toml)$/.test(path);

function parents(path, root) {
	let directory = dirname(path);
	while (directory !== root) {
		if (!directory.startsWith(`${root}/`)) fail("同步目标不在声明目录内。");
		if (existsSync(directory) && realpathSync(directory) !== directory) fail("同步目标的父目录含符号链接，请先人工核验。");
		directory = dirname(directory);
	}
}

function record(path) {
	let stat;
	try { stat = lstatSync(path); } catch (error) { if (error.code === "ENOENT") return { type: "missing" }; throw error; }
	if (stat.isSymbolicLink()) return { type: "symlink", value: readlinkSync(path) };
	if (!stat.isFile()) fail("同步目标已有实体目录或特殊文件，不会自动替换。");
	return { type: "file", content: readFileSync(path).toString("base64"), mode: stat.mode & 0o777 };
}

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const settingsText = path => existsSync(path) ? readFileSync(path, "utf8") : null;
function settingsObject(text) {
	if (text === null) return {};
	try { const value = JSON.parse(text); if (value && typeof value === "object" && !Array.isArray(value)) return value; } catch { /* sanitized below */ }
	fail("本机 Pi 设置无效，未覆盖个性化；请先修复设置。");
}
function engineering(repo, home) {
	const value = settingsObject(readFileSync(join(repo, "adapters/pi/settings.json"), "utf8"));
	const expand = entry => typeof entry === "string" ? entry.replaceAll("{{HOME}}", home) : Array.isArray(entry) ? entry.map(expand) : entry && typeof entry === "object" ? Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, expand(child)])) : entry;
	return Object.fromEntries(["packages", "skills"].filter(key => key in value).map(key => [key, expand(value[key])]));
}

/** Hash a regular generated output, never an arbitrary source or symlink. */
export function generatedOutputHash(repo, path) {
	if (!generated(path)) return undefined;
	const absolute = join(repo, path);
	try { return lstatSync(absolute).isFile() ? digest(readFileSync(absolute)) : undefined; }
	catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

/** Preflight and snapshot only owned generated outputs/projections/settings, before source fast-forward.
 * No installer, upstream runtime, Catalog code, credential/session directory or dry-run bootstrap is used.
 * Parent symlinks, native entities, invalid settings and extension collisions stop before any mutation.
 */
export function prepareCatalogActivation({ repo, home, engine, candidateFiles }) {
	repo = realpathSync(repo); home = realpathSync(home);
	const outputs = new Set(["AGENTS.md", "profiles/profile.schema.json"]);
	for (const path of candidateFiles) {
		const match = /^profiles\/([A-Za-z0-9][A-Za-z0-9._-]*)\.json$/.exec(path);
		if (match && match[1] !== "profile.schema") for (const output of [`adapters/pi/profiles/${match[1]}.json`, `adapters/codex/profiles/${match[1]}.config.toml`]) outputs.add(output);
	}
	for (const directory of ["adapters/pi/profiles", "adapters/codex/profiles"]) {
		parents(join(repo, directory, "placeholder"), repo);
		if (existsSync(join(repo, directory))) for (const name of readdirSync(join(repo, directory))) if (generated(`${directory}/${name}`)) outputs.add(`${directory}/${name}`);
	}
	const targets = new Map();
	const add = (path, source) => { if (targets.has(path) && targets.get(path) !== source) fail("个人资源与工具自带资源重名，未继续同步。"); targets.set(path, source); };
	for (const [source, path] of managedLinks(repo, home, engine)) add(path, projectionSource(source, repo, engine));
	for (const path of outputs) if (path.startsWith("adapters/codex/profiles/")) add(join(home, ".codex", path.split("/").at(-1)), join(repo, path));
	for (const path of candidateFiles) {
		if (/^adapters\/pi\/(?:agents|prompts)\/[^/]+\.md$/.test(path) || /^adapters\/pi\/extensions\/[^/]+(?:\/[^/]+)?\.(?:ts|mjs)$/.test(path)) add(join(home, ".pi/agent", path.slice("adapters/pi/".length)), join(repo, path));
	}
	const generatedBefore = {};
	for (const path of outputs) { parents(join(repo, path), repo); const value = record(join(repo, path)); if (value.type === "symlink") fail("生成目标不能是符号链接。"); generatedBefore[path] = value; }
	const nativeBefore = {};
	for (const [path] of targets) { parents(path, home); const value = record(path); if (value.type === "file") fail("原生投影已有实体文件，未自动替换；请先人工处理。"); nativeBefore[path] = value; }
	const settings = join(home, ".pi/agent/settings.json");
	parents(settings, home);
	const settingsBefore = record(settings);
	if (settingsBefore.type === "symlink") fail("本机设置仍是旧投影；请先保留个性化并转换成原生设置文件，再同步。");
	settingsObject(settingsText(settings));
	return { repo, home, engine, outputs: [...outputs], targets: [...targets], settings, settingsBefore, nativeBefore, generatedBefore };
}

/** Preserve the actual generated/native state before normalizing managed outputs or updating Git. */
export function snapshotCatalogActivation(plan, directory, commit) {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	if (realpathSync(directory) !== directory) fail("恢复记录目录含符号链接，未继续应用。");
	const path = join(directory, `configuration-${Date.now()}-${process.pid}.json`);
	writeFileSync(path, JSON.stringify({ repo: plan.repo, commit, generated: plan.generatedBefore, projections: plan.nativeBefore, settings: { path: plan.settings, ...plan.settingsBefore } }), { flag: "wx", mode: 0o600 });
	plan.snapshot = path;
	return path;
}

/** Only compiler-owned outputs already accepted by the source clean gate are normalized to HEAD.
 * Their exact prior bytes are preserved; CAS never touches editable source or unmanaged dirty files.
 */
export function normalizeGeneratedOutputs(plan, readHead) {
	for (const [path, before] of Object.entries(plan.generatedBefore)) {
		if (!same(record(join(plan.repo, path)), before)) fail("生成配置被其他程序修改，未继续同步。");
		const expected = readHead(path);
		if (before.type === "file") {
			const original = Buffer.from(before.content, "base64").toString("utf8");
			if (expected === null) unlinkSync(join(plan.repo, path));
			else if (expected !== original) atomicWrite(join(plan.repo, path), expected, `${process.pid}-sync`, original);
		}
	}
}

/** Apply approved configuration with bounded trusted Engine commands and per-stage source/native CAS.
 * Snapshot is 0600 outside both repositories. Failures keep partial-state evidence, never reset source
 * or restore over concurrent edits. Verification is static only; no packages or remote code are loaded.
 */
export function activateCatalogConfiguration(plan, { directory, commit, guardSource }) {
	const { repo, home, engine, outputs, targets, settings, nativeBefore, generatedBefore } = plan;
	const phases = [], started = Date.now(), deadline = started + 120_000;
	let snapshot = plan.snapshot;
	try {
		snapshot ??= snapshotCatalogActivation(plan, directory, commit);
		let nativeExpected = nativeBefore, settingsExpected = plan.settingsBefore;
		const sourcePaths = guardSource.paths.filter(path => !generated(path));
		const inputState = () => digest(JSON.stringify(sourcePaths.map(path => [path, record(join(repo, path))])));
		const sourceExpected = inputState();
		let generatedExpected = Object.fromEntries(outputs.map(path => [path, record(join(repo, path))]));
		const guard = () => {
			guardSource.check();
			if (inputState() !== sourceExpected) fail("应用期间配置来源被其他程序修改；未覆盖，请检查恢复记录。");
			for (const [path, value] of Object.entries(nativeExpected)) if (!same(record(path), value)) fail("应用期间原生投影被其他程序修改，已停止。");
			if (!same(record(settings), settingsExpected)) fail("应用期间本机设置被其他程序修改，已停止。");
			for (const [path, value] of Object.entries(generatedExpected)) if (!same(record(join(repo, path)), value)) fail("应用期间生成配置被其他程序修改，已停止。");
		};
		for (const [name, args] of [["generate", ["compose", "--apply"]], ["project", ["bootstrap", "--apply"]], ["verify", ["verify", "--catalog"]]]) {
			guard();
			const phaseStarted = Date.now();
			if (phaseStarted >= deadline) fail("配置应用超过两分钟预算，保留恢复记录。");
			const previousSettings = settingsText(settings);
			const desired = { ...settingsObject(previousSettings), ...engineering(repo, home) };
			const guardPath = `${snapshot}.${name}.guard.json`;
			writeFileSync(guardPath, JSON.stringify({ expected: { ...nativeExpected, [settings]: settingsExpected, ...Object.fromEntries(Object.entries(generatedExpected).map(([path, value]) => [join(repo, path), value])) } }), { flag: "wx", mode: 0o600 });
			const env = verificationEnvironment({ HOME: home, HARNESS_CATALOG: repo, HARNESS_CONFIGURATION_WRITE_GUARD: guardPath, HARNESS_EXPECTED_PI_SETTINGS_HASH: digest(previousSettings ?? "null") });
			const result = spawnSync(process.execPath, [join(engine, "scripts/harness.mjs"), ...args], { cwd: engine, env, encoding: "utf8", timeout: Math.min(60_000, deadline - phaseStarted), killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 });
			const log = `${snapshot}.${name}.log`;
			writeFileSync(log, `${result.stdout ?? ""}${result.stderr ?? ""}`, { flag: "wx", mode: 0o600 });
			const exited = result.status === 0 && !result.error && !result.signal;
			phases.push({ name, status: "failed", code: exited ? 0 : result.status || 1, durationMs: Date.now() - phaseStarted, log });
			if (!exited) fail(`配置${{ generate: "生成", project: "投影", verify: "静态检查" }[name]}未完成；源码已同步，保留快照供恢复。`);
			if (name === "generate") generatedExpected = Object.fromEntries(outputs.map(path => [path, record(join(repo, path))]));
			if (name === "project") {
				for (const [path, source] of targets) if (source.startsWith(`${repo}/`) && !existsSync(source)) {
					const value = record(path);
					if (value.type === "symlink" && resolve(dirname(path), value.value) === source) unlinkSync(path);
				}
				if (!isDeepStrictEqual(settingsObject(settingsText(settings)), desired)) fail("本机设置的工程合并结果不一致，已停止并保留恢复记录。");
				nativeExpected = Object.fromEntries(targets.map(([path]) => [path, record(path)])); settingsExpected = record(settings);
			}
			guard();
			phases.at(-1).status = "done";
		}
		return { ok: true, configurationApplied: true, needsApply: false, needsReload: true, phases, configurationBackup: snapshot,
			validation: { kind: "catalog-static", full: false }, generatedOutputs: Object.fromEntries(outputs.map(path => [path, generatedOutputHash(repo, path)])), durationMs: Date.now() - started };
	} catch (error) {
		return { ok: false, status: error.status ?? 422, error: error.status ? error.message : "配置应用未完成，请检查恢复记录与权限。", configurationApplied: false, needsApply: true,
			phases, ...(snapshot ? { configurationBackup: snapshot, recoveryRequired: true } : {}), durationMs: Date.now() - started };
	}
}
