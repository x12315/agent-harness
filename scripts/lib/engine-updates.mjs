import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { acquireCatalogLock, atomicWrite, releaseCatalogLock } from "../../adapters/pi/extensions/harness-manager-state.mjs";
import { ENGINE, HOME } from "./repo.mjs";
import { createSafeGit, credentialFreeGitSource } from "./safe-git.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const objectId = value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value ?? "");
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const checkError = "应用版本检查未完成。请在终端核验 origin/main、网络、仓库权限或 Git 锁；不会索取凭据或返回原始诊断。";
const messages = {
	unchecked: "尚未检查应用版本；不会自动联网。",
	current: "本地与最近获取的远端提交一致；不代表远端此刻没有更新。",
	behind: "应用有新版本。请先审阅变更，再在终端更新 Engine；不会自动安装或重启。",
	ahead: "本地提交领先于远端；不需要降级。",
	diverged: "本地与远端历史分叉，请人工核验，不能按普通升级处理。",
	unknown: "无法比较完整 Git 历史；请在终端核验仓库状态或浅克隆。",
};

function packageVersion(text) {
	try {
		const value = JSON.parse(text);
		return value.name === "harness-engine" && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/.test(value.version ?? "") && value.version.length <= 80 ? value.version : null;
	} catch { return null; }
}

function stateDirectory(home, engine, catalog) {
	const directory = join(realpathSync(resolve(home)), ".local/state/harness/engine-updates");
	for (const repo of [engine, catalog].filter(Boolean)) {
		const path = relative(existsSync(repo) ? realpathSync(repo) : resolve(repo), directory);
		if (!path.startsWith("../") && path !== "..") fail("应用检查状态不能存放在 Engine 或 Catalog 内。");
	}
	let parent = directory;
	while (!existsSync(parent)) parent = dirname(parent);
	if (realpathSync(parent) !== parent) fail("应用检查状态目录含符号链接；请人工核验。");
	return directory;
}

function context(engine, home, catalog, git) {
	engine = realpathSync(engine);
	if (git(engine, ["rev-parse", "--show-toplevel"]).text.trim() !== engine) fail("应用版本检查需要独立的 Engine Git 根目录。");
	const version = packageVersion(readFileSync(join(engine, "package.json"), "utf8"));
	if (!version) fail("Engine package.json 不包含可识别的应用版本。");
	const directory = stateDirectory(home, engine, catalog);
	const file = join(directory, `${digest(engine)}.json`);
	let text = null;
	if (existsSync(file)) {
		if (!lstatSync(file).isFile()) fail("应用检查状态不是普通文件；请人工核验。");
		text = readFileSync(file, "utf8");
	}
	const state = text === null ? {} : JSON.parse(text);
	return { engine, version, directory, file, text, state };
}

function save(ctx) {
	mkdirSync(ctx.directory, { recursive: true, mode: 0o700 });
	if (realpathSync(ctx.directory) !== ctx.directory) fail("应用检查状态目录含符号链接；请人工核验。");
	const text = `${JSON.stringify(ctx.state, null, 2)}\n`;
	if (ctx.text === null) writeFileSync(ctx.file, text, { flag: "wx", mode: 0o600 });
	else atomicWrite(ctx.file, text, process.pid, ctx.text);
	chmodSync(ctx.file, 0o600);
	ctx.text = text;
}

function source(ctx, git) {
	const remote = git(ctx.engine, ["remote", "get-url", "origin"], true);
	if (!remote.ok) fail("Engine 没有 origin 来源；请先在终端核验并登记。");
	return credentialFreeGitSource(remote.text.trim(), ctx.engine);
}

function report(ctx, git) {
	const head = git(ctx.engine, ["rev-parse", "HEAD"]).text.trim();
	const hasFilters = git(ctx.engine, ["config", "--get-regexp", "^filter\\."], true).ok;
	const dirty = hasFilters ? null : Boolean(git(ctx.engine, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all"]).text.trim());
	let selectedSource = null, blocked = "";
	try { selectedSource = source(ctx, git); }
	catch { blocked = "应用来源需人工核验：仅支持 Engine origin 的无凭据 HTTPS 或本机绝对 Git 路径。"; }
	const cached = selectedSource && ctx.state.source === selectedSource && objectId(ctx.state.commit);
	const commit = cached ? ctx.state.commit : null;
	let comparison = "unchecked";
	if (commit && git(ctx.engine, ["cat-file", "-e", `${commit}^{commit}`], true).ok) {
		if (commit === head) comparison = "current";
		else {
			const ancestor = git(ctx.engine, ["merge-base", "--is-ancestor", head, commit], true);
			const descendant = git(ctx.engine, ["merge-base", "--is-ancestor", commit, head], true);
			if (ancestor.ok) comparison = "behind";
			else if (descendant.ok) comparison = "ahead";
			else comparison = ancestor.code !== 1 || descendant.code !== 1 || git(ctx.engine, ["rev-parse", "--is-shallow-repository"]).text.trim() === "true" ? "unknown" : "diverged";
		}
	}
	const failed = Boolean(selectedSource && ctx.state.source === selectedSource && ctx.state.checkFailed);
	return {
		ok: true, status: 200, engine: ctx.engine, remote: "origin", branch: "main", source: selectedSource,
		version: ctx.version, head, dirty, worktreeWarning: hasFilters ? "存在自定义 Git 过滤器，未检查工作树以免执行代码；更新前请在终端人工核验。" : "", commit, remoteVersion: commit ? ctx.state.remoteVersion ?? null : null,
		automaticCheck: ctx.state.automaticCheck === true, preferencesHash: digest(JSON.stringify(ctx.state.automaticCheck === true)),
		checkedAt: cached ? ctx.state.checkedAt ?? null : null,
		attemptedAt: selectedSource === ctx.state.source ? ctx.state.attemptedAt ?? null : null,
		comparison, hasUpdate: comparison === "behind", checkFailed: failed, blocked,
		message: blocked || (failed ? `${checkError} 以下仅为上次成功获取的结果。` : messages[comparison]),
	};
}

/** Check the selected Engine's origin/main without checkout, merge, installation or code loading.
 * Status is offline. Configure changes only an opt-in native preference with CAS; checks fetch into
 * a private ref with a 60s total budget and 15min throttle (including failures). Cache never proves
 * the current remote state; source changes invalidate it. Catalog and native settings remain untouched.
 */
export function runEngineUpdates({ operation = "status", automaticCheck, expectedHash, force = false, automatic = false, engine = ENGINE, home = HOME, catalog } = {}) {
	const git = createSafeGit({ timeoutMessage: "应用版本检查超过 60 秒预算；请检查网络后重试。", errorMessage: checkError });
	let lock;
	try {
		if (!["status", "configure", "check"].includes(operation)) fail("未知应用版本检查操作。");
		let ctx = context(engine, home, catalog, git);
		if (operation === "status") return report(ctx, git);
		mkdirSync(ctx.directory, { recursive: true, mode: 0o700 });
		if (realpathSync(ctx.directory) !== ctx.directory) fail("应用检查状态目录含符号链接；请人工核验。");
		lock = acquireCatalogLock(ctx.file);
		ctx = context(engine, home, catalog, git);
		if (operation === "configure") {
			if (typeof automaticCheck !== "boolean") fail("请明确是否启用应用版本自动检查。");
			if (expectedHash !== report(ctx, git).preferencesHash) fail("应用检查设置已被其他页面修改；请刷新。", 409);
			ctx.state.automaticCheck = automaticCheck;
			save(ctx);
			return report(ctx, git);
		}
		if (automatic && ctx.state.automaticCheck !== true) return report(ctx, git);
		const selectedSource = source(ctx, git);
		if (!force && selectedSource === ctx.state.source && Date.now() - Date.parse(ctx.state.attemptedAt ?? "") < 15 * 60_000) return report(ctx, git);
		if (selectedSource !== ctx.state.source) ctx.state = { automaticCheck: ctx.state.automaticCheck === true };
		ctx.state.source = selectedSource;
		ctx.state.attemptedAt = new Date().toISOString();
		ctx.state.checkFailed = true;
		save(ctx);
		try {
			if (git(ctx.engine, ["config", "--get-regexp", "^url\\..*\\.insteadOf$"], true).ok) fail("存在 Git 来源重写配置，请在终端人工核验应用版本。", 409);
			const ref = `refs/harness/engine-updates/${digest(selectedSource)}`;
			git(ctx.engine, ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--no-auto-maintenance", selectedSource, `+refs/heads/main:${ref}`]);
			const commit = git(ctx.engine, ["rev-parse", "--verify", `${ref}^{commit}`]).text.trim();
			const packageText = git(ctx.engine, ["show", `${commit}:package.json`], true);
			const version = packageText.ok ? packageVersion(packageText.text) : null;
			if (!objectId(commit) || !version) fail("远端 main 不是可识别的 Harness Engine 版本；请人工核验来源。", 422);
			ctx.state.commit = commit;
			ctx.state.remoteVersion = version;
			ctx.state.checkedAt = new Date().toISOString();
			ctx.state.checkFailed = false;
		} catch (error) {
			ctx.state.checkFailed = true;
			save(ctx);
			return { ...report(ctx, git), ok: false, status: error.status ?? 422, error: error.status ? error.message : checkError };
		}
		save(ctx);
		return report(ctx, git);
	} catch (error) {
		return { ok: false, status: error.code === "ELOCKED" ? 423 : error.code === "ECHANGED" ? 409 : error.status ?? 500,
			error: error.status ? error.message : "应用版本检查未完成，请人工核验 Engine Git 状态与本机检查文件。" };
	} finally { if (lock) releaseCatalogLock(lock); }
}
