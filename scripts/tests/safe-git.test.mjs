import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSafeGit } from "../lib/safe-git.mjs";

test("Safe Git overrides authentication scripts, strips caller redirects and disables executable Git features", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-safe-git-")));
	const keys = ["PATH", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_DIR", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
	const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
	writeFileSync(join(root, "git"), `#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),env:Object.fromEntries(${JSON.stringify(keys)}.filter(key=>key!=='PATH').map(key=>[key,process.env[key]]))}));\n`);
	chmodSync(join(root, "git"), 0o755);
	try {
		Object.assign(process.env, { PATH: `${root}:${process.env.PATH}`, GIT_ASKPASS: "/unsafe/askpass", SSH_ASKPASS: "/unsafe/gui", GIT_DIR: "/unsafe/git", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/unsafe/hooks" });
		const git = createSafeGit({ timeoutMessage: "timeout", errorMessage: "failed" });
		const result = JSON.parse(git(root, ["status"]).text);
		assert.deepEqual(result.env, { GIT_ASKPASS: "/dev/null" });
		for (const setting of ["core.fsmonitor=false", "core.hooksPath=/dev/null", "protocol.allow=never", "http.followRedirects=false", "credential.helper=", "core.askPass=/dev/null"]) assert.ok(result.args.includes(setting));
		assert.equal(process.env.GIT_ASKPASS, "/unsafe/askpass", "parent environment remains unchanged");
		writeFileSync(join(root, "git"), `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`);
		const started = Date.now();
		const bounded = createSafeGit({ budgetMs: 150, timeoutMessage: "timeout", errorMessage: "failed" });
		assert.throws(() => bounded(root, ["fetch"]), /failed/);
		assert.ok(Date.now() - started < 2000, "a command ignoring SIGTERM must still be forcibly bounded");
	} finally {
		for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
		rmSync(root, { recursive: true, force: true });
	}
});
