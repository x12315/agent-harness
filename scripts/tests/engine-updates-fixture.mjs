import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateGitEnvironment } from "./web-fixture.mjs";

/** Disposable Engine source/clone/HOME; neither native credentials nor author configuration are copied.
 * Call restoreEnvironment and remove root after closing any worker/server.
 */
export function createEngineUpdatesFixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-engine-updates-")));
	const source = join(root, "source"), engine = join(root, "engine"), home = join(root, "home");
	mkdirSync(source); mkdirSync(home);
	const restoreEnvironment = isolateGitEnvironment(home);
	const git = (directory, ...args) => execFileSync("git", ["-C", directory, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git(source, "init", "-b", "main");
	git(source, "config", "user.name", "Fixture"); git(source, "config", "user.email", "fixture@example.test");
	writeFileSync(join(source, "package.json"), JSON.stringify({ name: "harness-engine", version: "0.1.0", scripts: { postinstall: "touch never-install" } }));
	writeFileSync(join(source, "README.md"), "Synthetic Engine version.\n");
	git(source, "add", "."); git(source, "commit", "-m", "fixture: engine version");
	git(root, "clone", source, engine);
	git(engine, "config", "user.name", "Fixture"); git(engine, "config", "user.email", "fixture@example.test");
	const update = (version = "0.2.0") => {
		writeFileSync(join(source, "package.json"), JSON.stringify({ name: "harness-engine", version }));
		git(source, "add", "package.json"); git(source, "commit", "-m", "fixture: new engine version");
	};
	return { root, source, engine, home, git, update, restoreEnvironment };
}
