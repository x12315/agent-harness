import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

const fail = (message, status) => { throw Object.assign(new Error(message), { status }); };
const gitOptions = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.file.allow=always", "-c", "http.followRedirects=false", "-c", "credential.helper=", "-c", "core.askPass=/dev/null"];

/** Create a bounded Git runner without hooks, prompts, caller Git redirects or raw diagnostics.
 * Only HTTPS/file transports are enabled. Local Git configuration is still read; callers must
 * validate the selected source and reject custom filters before changing a worktree.
 */
export function createSafeGit({ budgetMs = 60_000, timeoutMessage, errorMessage }) {
	const deadline = Date.now() + budgetMs;
	return (repo, args, optional = false, input) => {
		if (Date.now() >= deadline) fail(timeoutMessage, 422);
		const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" };
		for (const key of Object.keys(env)) if (/^GIT_(?:DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*|PREFIX|EXEC_PATH|SSH.*|ASKPASS)$/.test(key)) delete env[key];
		env.GIT_ASKPASS = "/dev/null";
		delete env.SSH_ASKPASS;
		const result = spawnSync("git", ["-C", repo, ...gitOptions, ...args], {
			env, input, encoding: "utf8", killSignal: "SIGKILL", timeout: Math.min(30_000, Math.max(1, deadline - Date.now())), maxBuffer: 4 * 1024 * 1024,
		});
		if (result.error || result.signal) fail(errorMessage, 422);
		if (result.status !== 0 && !optional) fail(errorMessage, 422);
		return { ok: result.status === 0, code: result.status ?? 128, text: result.stdout ?? "" };
	};
}

/** Normalize a credential-free HTTPS URL or existing absolute path; reject an optional protected root. */
export function credentialFreeGitSource(value, forbiddenRoot) {
	if (!value || /[\x00-\x20\x7f]/.test(value)) fail("来源必须是无凭据 HTTPS 地址或本机绝对 Git 路径。", 400);
	if (isAbsolute(value)) {
		const path = realpathSync(value);
		if (forbiddenRoot && path === realpathSync(forbiddenRoot)) fail("同步来源不能引用当前 Harness 工具仓。", 400);
		return path;
	}
	let url;
	try { url = new URL(value); } catch { fail("来源必须是无凭据 HTTPS 地址或本机绝对 Git 路径。", 400); }
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) fail("来源含凭据或使用不支持的协议；请先在终端登记无凭据 HTTPS remote。", 400);
	return url.href;
}
