import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCatalogSync } from "../lib/catalog-sync.mjs";
import { ENGINE } from "../lib/repo.mjs";

const git = (root, ...args) => execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function fixture(action) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-config-sync-")));
	const source = join(root, "source"), repo = join(root, "catalog"), home = join(root, "home");
	mkdirSync(source); mkdirSync(home);
	git(source, "init", "-b", "main");
	git(source, "config", "user.name", "Fixture"); git(source, "config", "user.email", "fixture@example.test");
	writeFileSync(join(source, "harness.catalog.json"), '{"schemaVersion":1}\n');
	writeFileSync(join(source, ".gitignore"), "*.harness.lock\n/skills/*\n");
	writeFileSync(join(source, "README.md"), "Configuration fixture.\n");
	git(source, "add", "."); git(source, "commit", "-m", "fixture: initial config");
	git(root, "clone", source, repo);
	git(repo, "config", "user.name", "Fixture"); git(repo, "config", "user.email", "fixture@example.test");
	const invoke = options => runCatalogSync({ repo, home, engine: ENGINE, ...options });
	const register = (options = {}) => invoke({ operation: "register", remote: "origin", branch: "main", automaticCheck: false, expectedHash: invoke({}).registrationHash, ...options });
	const update = (path = "README.md", text = "Updated configuration.\n") => {
		mkdirSync(join(source, path, ".."), { recursive: true });
		writeFileSync(join(source, path), text); git(source, "add", "--force", path); git(source, "commit", "-m", "fixture: update config");
	};
	try { return action({ root, source, repo, home, invoke, register, update }); }
	finally { rmSync(root, { recursive: true, force: true }); }
}

function apply(invoke, review, overrides = {}) {
	return invoke({ operation: "apply", expectedHash: review.registrationHash, expectedHead: review.head, expectedCommit: review.commit, ...overrides });
}

test("Registration is local, CAS protected, opt-in; status does not fetch; review and apply pin commits", () => fixture(({ source, repo, home, invoke, register, update }) => {
	const initial = invoke({}); assert.equal(initial.registration, null); assert.equal(initial.commit, null);
	assert.equal(invoke({ operation: "check" }).status, 400);
	const registered = register(); assert.equal(registered.ok, true); assert.equal(registered.registration.automaticCheck, false);
	assert.equal(invoke({ operation: "register", remote: "origin", branch: "main", automaticCheck: true, expectedHash: initial.registrationHash }).status, 409);
	update(); assert.equal(invoke({}).commit, null);
	const review = invoke({ operation: "check", force: true });
	assert.equal(review.canSync, true, JSON.stringify(review)); assert.deepEqual(review.files, ["README.md"]);
	const head = git(repo, "rev-parse", "HEAD"); assert.notEqual(head, git(source, "rev-parse", "HEAD"));
	assert.equal(apply(invoke, review, { expectedCommit: "0".repeat(40) }).status, 409);
	const result = apply(invoke, review); assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.synced, true); assert.equal(result.needsApply, true); assert.equal(result.hasUpdate, false);
	assert.equal(git(repo, "status", "--porcelain"), "");
	assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "Updated configuration.\n");
	assert.ok(result.backup.startsWith(home)); assert.equal(statSync(result.backup).mode & 0o777, 0o600);
	assert.equal(existsSync(join(home, ".pi/agent/settings.json")), false, "no installation or native settings");
	assert.equal(git(source, "rev-parse", "HEAD"), result.commit, "no push or mutation of source");
}));

test("Dirty, untracked, divergent histories and shared locks never stash, reset or overwrite", () => fixture(({ repo, invoke, register, update }) => {
	register(); update(); const review = invoke({ operation: "check", force: true });
	writeFileSync(join(repo, "README.md"), "Local edit.\n");
	assert.equal(apply(invoke, review).status, 409); assert.match(readFileSync(join(repo, "README.md"), "utf8"), /Local edit/);
	git(repo, "checkout", "--", "README.md"); writeFileSync(join(repo, "untracked"), "keep");
	assert.equal(apply(invoke, review).status, 409); assert.equal(readFileSync(join(repo, "untracked"), "utf8"), "keep"); rmSync(join(repo, "untracked"));
	writeFileSync(join(repo, ".catalog.harness.lock"), "external owner\n");
	assert.equal(apply(invoke, review).status, 423); assert.equal(readFileSync(join(repo, ".catalog.harness.lock"), "utf8"), "external owner\n"); rmSync(join(repo, ".catalog.harness.lock"));
	writeFileSync(join(repo, "README.md"), "Local commit.\n"); git(repo, "add", "."); git(repo, "commit", "-m", "fixture: local branch");
	const diverged = invoke({ operation: "check", force: true }); assert.equal(diverged.canSync, false); assert.match(diverged.blocked, /快进/);
	assert.equal(apply(invoke, diverged).status, 409); assert.match(readFileSync(join(repo, "README.md"), "utf8"), /Local commit/);
}));

test("Source changes invalidate registration; credentials and command-shaped remote/branches are rejected", () => fixture(({ source, repo, invoke, register }) => {
	register(); git(repo, "remote", "set-url", "origin", "https://user:secret@example.test/config.git");
	const status = invoke({}); assert.equal(status.remotes[0].source, null); assert.equal(JSON.stringify(status).includes("user:secret"), false);
	assert.equal(invoke({ operation: "check", force: true }).status, 400);
	assert.equal(register().status, 400); git(repo, "remote", "set-url", "origin", source);
	assert.equal(register({ remote: "--upload-pack=echo" }).status, 400);
	assert.equal(register({ branch: "main;touch" }).status, 400);
	assert.equal(register({ branch: "../main" }).status, 400);
	assert.equal(register({ automaticCheck: "true" }).status, 400);
	const result = register({ automaticCheck: true }); assert.equal(result.ok, true); assert.equal(result.registration.automaticCheck, true);
}));

test("Remote non-Catalog paths and unsupported manifests are rejected before checkout", () => fixture(({ repo, invoke, register, update }) => {
	register(); update("bin/harness", "Never execute me.\n");
	let review = invoke({ operation: "check", force: true }); assert.equal(review.canSync, false); assert.match(review.blocked, /非配置/);
	assert.equal(apply(invoke, review).status, 409); assert.equal(existsSync(join(repo, "bin/harness")), false);
}));

test("Credential-shaped remote content and unowned Skill copies are not materialized or leaked", () => fixture(({ repo, source, invoke, register, update }) => {
	register();
	const secret = "gh" + "p_" + "A".repeat(36);
	update("README.md", `Unsafe remote content: ${secret}\n`);
	let review = invoke({ operation: "check", force: true });
	assert.equal(review.canSync, false); assert.match(review.blocked, /凭据/);
	assert.equal(JSON.stringify(review).includes(secret), false);
	assert.equal(readFileSync(join(repo, "README.md"), "utf8").includes(secret), false);
	writeFileSync(join(source, "README.md"), "Safe again.\n"); git(source, "add", "README.md");
	update("skills/third-party/SKILL.md", "Unowned installation copy.\n");
	review = invoke({ operation: "check", force: true });
	assert.equal(review.canSync, false); assert.match(review.blocked, /未白名单/);
	assert.equal(existsSync(join(repo, "skills/third-party/SKILL.md")), false);
}));

test("Unsupported manifest is not materialized", () => fixture(({ repo, invoke, register, update }) => {
	register(); update("harness.catalog.json", '{"schemaVersion":2}\n');
	const review = invoke({ operation: "check", force: true }); assert.equal(review.canSync, false); assert.match(review.blocked, /契约/);
	assert.equal(apply(invoke, review).status, 409); assert.equal(JSON.parse(readFileSync(join(repo, "harness.catalog.json"))).schemaVersion, 1);
}));

test("Symlinks, hooks, custom filters, ignored-file collisions and automatic checks are bounded", () => fixture(({ source, repo, invoke, register, update }) => {
	register({ automaticCheck: true }); update(); const first = invoke({ operation: "check", force: true });
	const hooks = join(repo, ".git/hooks"); mkdirSync(hooks, { recursive: true });
	const marker = join(repo, "hook-ran"); writeFileSync(join(hooks, "post-merge"), `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(join(hooks, "post-merge"), 0o755);
	git(repo, "config", "filter.untrusted.smudge", "touch should-never-run");
	assert.match(apply(invoke, first).error, /过滤器/); git(repo, "config", "--remove-section", "filter.untrusted");
	assert.equal(apply(invoke, first).ok, true); assert.equal(existsSync(marker), false);
	writeFileSync(join(source, ".gitignore"), "*.harness.lock\n/skills/*\n!/skills/example/\n");
	git(source, "add", ".gitignore");
	update("skills/example/SKILL.md", "---\nname: example\ndescription: Fixture skill.\n---\n");
	assert.equal(invoke({ operation: "check" }).commit, first.commit, "throttled checks must not fetch");
	const second = invoke({ operation: "check", force: true });
	mkdirSync(join(repo, "skills/example"), { recursive: true }); writeFileSync(join(repo, "skills/example/SKILL.md"), "Ignored installation to preserve.\n");
	const collision = apply(invoke, second); assert.equal(collision.ok, false); assert.ok(collision.backup);
	assert.equal(readFileSync(join(repo, "skills/example/SKILL.md"), "utf8"), "Ignored installation to preserve.\n");
	symlinkSync("/tmp", join(source, "profiles-link")); git(source, "add", "profiles-link"); git(source, "commit", "-m", "fixture: unsafe link");
	const linked = invoke({ operation: "check", force: true }); assert.equal(linked.canSync, false);
}));

test("Engine identity and caller Git redirects cannot change the sync target", () => fixture(({ repo, invoke }) => {
	assert.equal(runCatalogSync({ repo: ENGINE }).ok, false);
	const previous = process.env.GIT_DIR; process.env.GIT_DIR = join(ENGINE, ".git");
	try { assert.equal(invoke({}).repo, repo); }
	finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; }
}));
