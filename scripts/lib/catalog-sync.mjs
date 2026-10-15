import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { acquireCatalogLock, atomicWrite, releaseCatalogLock } from "../../adapters/pi/extensions/harness-manager-state.mjs";
import { ENGINE, HOME, assertCatalog } from "./repo.mjs";
import { scanText } from "../secret-scan.mjs";
import { createSafeGit, credentialFreeGitSource } from "./safe-git.mjs";
import { summarizeCatalogChanges } from "./catalog-sync-summary.mjs";
import { activateCatalogConfiguration, generatedOutputHash, normalizeGeneratedOutputs, prepareCatalogActivation, snapshotCatalogActivation } from "./catalog-sync-activation.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const objectId = value => /^[a-f0-9]{40,64}$/.test(value ?? "");
const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
let git;
const approvedSource = credentialFreeGitSource;

function context(repo, home, engine) {
	repo = realpathSync(repo);
	assertCatalog(repo);
	if (repo === realpathSync(engine) || git(repo, ["rev-parse", "--show-toplevel"]).text.trim() !== repo) fail("只能同步独立的 Catalog Git 根目录。", 400);
	const directory = join(realpathSync(resolve(home)), ".local/state/harness/catalog-sync");
	let existingParent = directory;
	while (!existsSync(existingParent)) existingParent = resolve(existingParent, "..");
	if (realpathSync(existingParent) !== existingParent) fail("同步状态父目录含符号链接，请人工核验。", 400);
	if (!relative(repo, directory).startsWith("..")) fail("本机同步状态与备份不能存放在 Catalog 内。", 400);
	const file = join(directory, `${digest(repo)}.json`);
	let text = null;
	if (existsSync(file)) {
		if (!lstatSync(file).isFile()) fail("同步登记文件不是普通文件；请人工核验。", 400);
		text = readFileSync(file, "utf8");
	}
	const state = text === null ? {} : JSON.parse(text);
	return { repo, directory, file, text, state, registrationHash: digest(JSON.stringify(state.registration ?? null)) };
}

function save(ctx) {
	mkdirSync(ctx.directory, { recursive: true, mode: 0o700 });
	if (realpathSync(ctx.directory) !== ctx.directory) fail("同步状态目录含符号链接；请人工核验。", 400);
	const text = `${JSON.stringify(ctx.state, null, 2)}\n`;
	if (ctx.text === null) writeFileSync(ctx.file, text, { flag: "wx", mode: 0o600 });
	else atomicWrite(ctx.file, text, process.pid, ctx.text);
	chmodSync(ctx.file, 0o600);
	ctx.text = text;
}

function hasApplicableFilters(repo, extraPaths = []) {
	const configured = git(repo, ["config", "--get-regexp", "^filter\\."], true);
	if (!configured.ok) { if (configured.code === 1) return false; fail("Git 过滤器配置无法安全读取，未继续同步。", 409); }
	const paths = [...new Set([...git(repo, ["ls-files", "-co", "--exclude-standard", "-z"]).text.split("\0").filter(Boolean), ...extraPaths])];
	if (!paths.length) return false;
	const attributes = git(repo, ["check-attr", "-z", "--stdin", "filter"], false, `${paths.join("\0")}\0`).text.split("\0");
	return attributes.some((value, index) => index % 3 === 2 && !["unspecified", "unset"].includes(value));
}

function dirty(repo, generatedOutputs = {}) {
	if (hasApplicableFilters(repo)) fail("存在自定义 Git 过滤器，请在终端人工核验同步；网页不会执行过滤器。", 409);
	return git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"]).text.split("\0")
		.filter(line => {
			if (!line || line.slice(3) === ".catalog.harness.lock") return false;
			const path = line.slice(3);
			return !Object.hasOwn(generatedOutputs, path) || ![" M", " D", "??"].includes(line.slice(0, 2)) || generatedOutputHash(repo, path) !== generatedOutputs[path];
		}).length > 0;
}

function sourceFor(repo, remote, engine) {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(remote ?? "")) fail("请选择当前配置仓已登记的 remote。", 400);
	const source = git(repo, ["remote", "get-url", remote], true);
	if (!source.ok) fail("Git remote 已不存在，请重新登记。", 400);
	return approvedSource(source.text.trim(), engine);
}

function cachedRef(ctx) { return `refs/harness/catalog-sync/${digest(`${ctx.repo}\0${JSON.stringify(ctx.state.registration)}`)}`; }

function allowedPath(path) {
	return !/[\x00-\x1f\x7f]/.test(path) && !path.split("/").some(part => part === ".." || part === ".git") && (
		["harness.catalog.json", ".gitignore", ".skill-lock.json", "expected-gaps.json", "AGENTS.md", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "scripts/git-hooks/pre-commit"].includes(path)
		|| /^(instructions|profiles|skills)\//.test(path) || /^adapters\/(pi|codex)\//.test(path)
	);
}

function assertArchiveSafe(repo, head) {
	const paths = git(repo, ["ls-tree", "-r", "--name-only", "-z", head]).text;
	if (!paths) return;
	const attributes = git(repo, ["check-attr", "-z", "--stdin", "export-ignore", "export-subst"], false, paths).text.split("\0");
	if (attributes.some((value, index) => index % 3 === 2 && !["unspecified", "unset"].includes(value))) fail("仓库快照属性可能省略或改写源码；未同步，请先人工保留完整备份。", 409);
}

function treeReader(repo, commit) {
	return path => { const result = git(repo, ["show", `${commit}:${path}`], true); return result.ok ? result.text : null; };
}

function summaryFor(repo, head, commit, files) {
	return summarizeCatalogChanges({ readBefore: treeReader(repo, head), readAfter: treeReader(repo, commit), files });
}

function missingInstallations(repo, home, commit, changes = []) {
	const desired = summarizeCatalogChanges({ readBefore: () => null, readAfter: treeReader(repo, commit), files: [".skill-lock.json", "adapters/pi/settings.json"] }).installationChanges;
	return desired.filter(item => {
		if (changes.some(change => change.kind === item.kind && change.name === item.name)) return false;
		if (item.kind === "skill") return !existsSync(join(repo, "skills", item.name, "SKILL.md"));
		const source = item.source.replaceAll("{{HOME}}", home);
		let manifest, expectedVersion;
		if (source.startsWith("npm:")) {
			const match = /^npm:((?:@[^/]+\/)?[^@]+)(?:@(.+))?$/.exec(source);
			if (!match) return true;
			manifest = join(home, ".pi/agent/npm/node_modules", match[1], "package.json"); expectedVersion = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(match[2] ?? "") ? match[2] : undefined;
		} else if (source.startsWith("git:")) {
			try { const url = new URL(source.slice(4).replace(/@.*$/, "").replace(/^github\.com\//, "https://github.com/")); return !existsSync(join(home, ".pi/agent/git", url.hostname, url.pathname.replace(/^\//, "").replace(/\.git$/, ""), ".git")); } catch { return true; }
		} else if (source.startsWith("/") || source.startsWith("~/")) return !existsSync(source.replace(/^~\//, `${home}/`));
		else return true;
		try { const value = JSON.parse(readFileSync(manifest, "utf8")); return !value || (expectedVersion && value.version !== expectedVersion); } catch { return true; }
	}).map(item => ({ ...item, operation: "repair" }));
}

function reviewTree(repo, commit) {
	const files = git(repo, ["ls-tree", "-r", "-z", commit]).text.split("\0").filter(Boolean);
	const ignore = git(repo, ["show", `${commit}:.gitignore`], true).text;
	const own = new Set([...ignore.matchAll(/^!\/skills\/([^/]+)\/$/gm)].map(match => match[1]));
	if (files.length > 2500) fail("配置树过大，请人工审阅后同步。", 422);
	for (const line of files) {
		const separator = line.indexOf("\t");
		const metadata = line.slice(0, separator), path = line.slice(separator + 1);
		if (path.split("/").includes(".gitattributes") || !allowedPath(path) || !/^100(?:644|755) blob /.test(metadata)) fail("远端包含非配置路径、符号链接或子模块；自动同步已停止。", 422);
		if (path.startsWith("skills/") && !own.has(path.split("/")[1])) fail("远端包含未白名单声明的 Skill 副本；第三方安装内容不能随配置同步。", 422);
		const blob = metadata.split(" ")[2];
		if (Number(git(repo, ["cat-file", "-s", blob]).text) > 512 * 1024) fail("远端配置文件过大，请人工审阅。", 422);
		if (scanText(path, git(repo, ["cat-file", "blob", blob]).text).length) fail("远端包含疑似凭据，未展示或写入工作目录。", 422);
	}
	let manifest;
	try { manifest = JSON.parse(git(repo, ["show", `${commit}:harness.catalog.json`]).text); }
	catch { fail("远端不是 Catalog API v1 配置仓。", 422); }
	if (manifest?.schemaVersion !== 1 || Object.keys(manifest).some(key => key !== "schemaVersion")) fail("远端配置仓契约不兼容。", 422);
}

function report(ctx, engine) {
	const { registration, checkedAt } = ctx.state;
	const head = git(ctx.repo, ["rev-parse", "HEAD"]).text.trim();
	const branch = git(ctx.repo, ["symbolic-ref", "--short", "HEAD"], true).text.trim();
	const remotes = git(ctx.repo, ["remote"]).text.trim().split("\n").filter(Boolean).map(name => {
		try { return { name, source: sourceFor(ctx.repo, name, engine), supported: true }; }
		catch { return { name, source: null, supported: false }; }
	});
	const commit = registration ? git(ctx.repo, ["rev-parse", "--verify", cachedRef(ctx)], true).text.trim() : "";
	const hasUpdate = Boolean(objectId(commit) && commit !== head);
	const fastForward = hasUpdate && git(ctx.repo, ["merge-base", "--is-ancestor", head, commit], true).ok;
	const candidatePaths = commit && ctx.state.reviewedCommit === commit ? git(ctx.repo, ["ls-tree", "-r", "--name-only", "-z", commit]).text.split("\0").filter(Boolean) : [];
	const hasFilters = hasApplicableFilters(ctx.repo, candidatePaths);
	const generatedOutputs = ctx.state.application?.configurationApplied ? ctx.state.application.generatedOutputs ?? {} : {};
	const isDirty = hasFilters ? null : dirty(ctx.repo, generatedOutputs);
	let blocked = "";
	if (!registration) blocked = "尚未登记同步来源；不会自动联网。";
	else if (!remotes.some(item => item.name === registration.remote && item.source === registration.source)) blocked = "remote 来源已变化；请重新登记。";
	else if (!branch) blocked = "当前处于 detached HEAD，请先在终端选择配置分支。";
	else if (hasFilters) blocked = "存在自定义 Git 过滤器，未检查工作树或允许同步；请在终端人工核验。";
	else if (isDirty) blocked = "配置仓有本地改动或未跟踪文件。先自行保存、提交或处理；不会自动 stash、删除或覆盖。";
	else if (hasUpdate && !fastForward) blocked = "本地与远端历史不支持快进。请人工处理分叉或远端回退。";
	else if (ctx.state.reviewError) blocked = ctx.state.reviewError;
	else if (hasUpdate && (ctx.state.reviewedCommit !== commit || ctx.state.reviewedHead !== head || ctx.state.reviewedBranch !== branch)) blocked = "候选或本地提交未经本次审阅，请重新检查。";
	return {
		ok: true, status: 200, repo: ctx.repo, registration: registration ?? null, registrationHash: ctx.registrationHash,
		remotes, head, branch, commit: objectId(commit) ? commit : null, checkedAt: checkedAt ?? null,
		dirty: isDirty, hasUpdate, canSync: Boolean(hasUpdate && fastForward && !blocked), blocked,
		canApplyConfiguration: Boolean(commit && !blocked && ctx.state.summary && ctx.state.reviewedCommit === commit && ctx.state.reviewedHead === head && ctx.state.reviewedBranch === branch),
		files: ctx.state.reviewedCommit === commit ? ctx.state.files ?? [] : [],
		backup: ctx.state.backup ?? null, lastSyncedAt: ctx.state.lastSyncedAt ?? null,
		summary: ctx.state.reviewedCommit === commit && ctx.state.reviewedHead === head ? ctx.state.summary ?? null : null,
		application: ctx.state.application?.commit === head ? ctx.state.application : null,
	};
}

/** Local registration, opt-in fetch/review, or explicitly approved fast-forward of one Catalog.
 * Shares the editor lock and registration/HEAD/commit CAS. Never stashes, resets, pushes, runs hooks,
 * imports remote code or installs dependencies. apply remains source-only; sync additionally generates
 * and projects approved configuration with a native snapshot and static-only verification; Engine is never edited.
 * State/0600 source archives live outside Git. Failures keep a recovery record; no blind rollback.
 * Status never fetches. Checks are throttled to 15 minutes; confirmation is required. Total Git budget: 60s.
 */
export function runCatalogSync({ repo, operation = "status", remote, branch, automaticCheck, expectedHash, expectedHead, expectedCommit, force = false, automatic = false, home = HOME, engine = ENGINE }) {
	let lock;
	let backup;
	let activation;
	let synced = false;
	git = createSafeGit({
		timeoutMessage: "配置同步操作超过 60 秒预算；保留已有状态，请检查网络与仓库规模后重试。",
		errorMessage: "Git 操作未完成。请在终端核验网络、认证、仓库权限或残留 Git 锁；网页不返回原始诊断或索取凭据。",
	});
	try {
		if (!["status", "register", "check", "apply", "sync"].includes(operation)) fail("未知配置同步操作。", 400);
		if (automatic && ["apply", "sync"].includes(operation)) fail("自动请求仅允许检查，不会同步或应用配置。", 409);
		const ctx = context(repo, home, engine);
		if (operation === "status") return report(ctx, engine);
		lock = acquireCatalogLock(join(ctx.repo, ".catalog"));
		if (operation === "register") {
			if (expectedHash !== ctx.registrationHash) fail("同步登记已被其他页面修改；请刷新。", 409);
			if (typeof automaticCheck !== "boolean" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,160}$/.test(branch ?? "") || !git(ctx.repo, ["check-ref-format", "--branch", branch], true).ok) fail("请输入合法分支名并明确是否启用自动检查。", 400);
			ctx.state = { registration: { remote, branch, source: sourceFor(ctx.repo, remote, engine), automaticCheck } };
			save(ctx);
			return report(context(repo, home, engine), engine);
		}
		const registration = ctx.state.registration;
		if (!registration) fail("请先登记配置仓的 remote 和分支。", 400);
		if (sourceFor(ctx.repo, registration.remote, engine) !== registration.source) fail("remote 来源已变化；请重新登记。", 409);
		if (operation === "check") {
			if (automatic && !registration.automaticCheck) return report(ctx, engine);
			if (!force && Date.now() - Date.parse(ctx.state.checkedAt ?? "") < 15 * 60_000) return report(ctx, engine);
			git(ctx.repo, ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--no-auto-maintenance", registration.source, `+refs/heads/${registration.branch}:${cachedRef(ctx)}`]);
			const commit = git(ctx.repo, ["rev-parse", cachedRef(ctx)]).text.trim();
			ctx.state.checkedAt = new Date().toISOString();
			ctx.state.reviewError = "";
			ctx.state.reviewedCommit = null;
			ctx.state.files = [];
			ctx.state.summary = null;
			try {
				reviewTree(ctx.repo, commit);
				ctx.state.files = git(ctx.repo, ["diff", "--name-only", "-z", "HEAD", commit]).text.split("\0").filter(Boolean);
				ctx.state.reviewedCommit = commit;
				ctx.state.reviewedHead = git(ctx.repo, ["rev-parse", "HEAD"]).text.trim();
				ctx.state.reviewedBranch = git(ctx.repo, ["symbolic-ref", "--short", "HEAD"], true).text.trim();
				ctx.state.summary = summaryFor(ctx.repo, ctx.state.reviewedHead, commit, ctx.state.files);
				ctx.state.summary.missingInstallations = missingInstallations(ctx.repo, home, commit, ctx.state.summary.installationChanges);
			} catch (error) { ctx.state.reviewError = error.message; }
			save(ctx);
			return report(ctx, engine);
		}
		const latest = report(ctx, engine);
		if (expectedHash !== ctx.registrationHash || expectedHead !== latest.head || expectedCommit !== latest.commit || !objectId(expectedHead) || !objectId(expectedCommit)) fail("登记、当前提交或远端候选已变化；请重新检查并审阅。", 409);
		if (!(operation === "sync" ? latest.canApplyConfiguration : latest.canSync) || ctx.state.reviewedCommit !== expectedCommit) fail(latest.blocked || "先检查并审阅有效的远端更新。", 409);
		if (hasApplicableFilters(ctx.repo, latest.files)) fail("存在自定义 Git 过滤器，请在终端人工核验同步；网页不会执行过滤器。", 409);
		reviewTree(ctx.repo, expectedCommit);
		if (operation === "sync") {
			const summary = summaryFor(ctx.repo, expectedHead, expectedCommit, latest.files);
			const missing = missingInstallations(ctx.repo, home, expectedCommit, summary.installationChanges);
			if (summary.requiresInstallation || missing.length) return { ...latest, ok: false, status: 422, error: "本次涉及安装条目变化或缺失资源。请先审阅安装条目；轻量同步不会隐藏下载、卸载或覆盖。", installationRequired: true, summary: { ...summary, missingInstallations: missing } };
			const candidateFiles = git(ctx.repo, ["ls-tree", "-r", "--name-only", "-z", expectedCommit]).text.split("\0").filter(Boolean);
			activation = prepareCatalogActivation({ repo: ctx.repo, home, engine, candidateFiles });
			snapshotCatalogActivation(activation, ctx.directory, expectedCommit);
		}
		assertArchiveSafe(ctx.repo, expectedHead);
		mkdirSync(ctx.directory, { recursive: true, mode: 0o700 });
		backup = join(ctx.directory, `before-${digest(ctx.repo).slice(0, 12)}-${Date.now()}-${process.pid}.tar`);
		writeFileSync(backup, "", { flag: "wx", mode: 0o600 });
		git(ctx.repo, ["archive", "--format=tar", `--output=${backup}`, expectedHead]);
		chmodSync(backup, 0o600);
		if (activation) normalizeGeneratedOutputs(activation, treeReader(ctx.repo, expectedHead));
		ctx.state.backup = backup;
		ctx.state.recovery = { before: expectedHead, candidate: expectedCommit, branch: latest.branch };
		save(ctx);
		if (dirty(ctx.repo, ctx.state.application?.configurationApplied ? ctx.state.application.generatedOutputs : {}) || git(ctx.repo, ["rev-parse", "HEAD"]).text.trim() !== expectedHead) fail("备份期间出现外部改动；未继续同步。", 409);
		git(ctx.repo, ["merge", "--ff-only", "--no-edit", "--no-overwrite-ignore", expectedCommit]);
		if (git(ctx.repo, ["rev-parse", "HEAD"]).text.trim() !== expectedCommit || dirty(ctx.repo, ctx.state.application?.configurationApplied ? ctx.state.application.generatedOutputs : {})) fail("同步后的磁盘或提交状态不一致；保留快照供人工恢复，不覆盖外部改动。", 409);
		synced = true;
		ctx.state.lastSyncedAt = new Date().toISOString();
		save(ctx);
		if (activation) {
			const guardedGit = createSafeGit({ budgetMs: 180_000, timeoutMessage: "配置来源复核超过预算。", errorMessage: "配置来源复核未完成。" });
			git = guardedGit;
			const application = activateCatalogConfiguration(activation, { directory: ctx.directory, commit: expectedCommit, guardSource: {
				paths: activation.outputs.length ? git(ctx.repo, ["ls-tree", "-r", "--name-only", "-z", expectedCommit]).text.split("\0").filter(Boolean) : [],
				check: () => { if (guardedGit(ctx.repo, ["rev-parse", "HEAD"]).text.trim() !== expectedCommit || guardedGit(ctx.repo, ["symbolic-ref", "--short", "HEAD"], true).text.trim() !== latest.branch || sourceFor(ctx.repo, registration.remote, engine) !== registration.source) fail("应用期间来源或当前分支被外部修改，已停止。"); },
			} });
			ctx.state.application = { ...application, commit: expectedCommit, summary: latest.summary };
			save(ctx);
			git = createSafeGit({ timeoutMessage: "同步状态复核超时。", errorMessage: "同步状态复核未完成。" });
			return { ...report(ctx, engine), ...application, synced: true, sourceChanged: latest.hasUpdate, status: application.ok ? 200 : application.status, backup };
		}
		return { ...report(ctx, engine), synced: true, needsApply: true };
	} catch (error) {
		return { ok: false, status: error.code === "ELOCKED" ? 423 : error.code === "ECHANGED" ? 409 : error.status ?? 500, error: error.status ? error.message : "配置同步未完成，请人工核验登记文件、Git 状态与权限。", ...(activation?.snapshot ? { configurationBackup: activation.snapshot, recoveryRequired: true } : {}), ...(synced ? { synced: true, configurationApplied: false, needsApply: true } : {}), ...(backup ? { backup, recoveryRequired: true } : {}) };
	} finally { if (lock) releaseCatalogLock(lock); }
}
