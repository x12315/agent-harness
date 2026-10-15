import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ENGINE } from "../lib/repo.mjs";
import { createCatalogSyncFixture } from "./web-fixture.mjs";

const guardModule = pathToFileURL(join(ENGINE, "scripts/lib/configuration-write-guard.mjs")).href;
const composeModule = pathToFileURL(join(ENGINE, "scripts/compose.mjs")).href;
const digest = text => createHash("sha256").update(text).digest("hex");

function fixture(callback) {
	const data = createCatalogSyncFixture();
	const env = { HOME: data.home, HARNESS_CATALOG: data.repo, PI_OFFLINE: "1" };
	const child = (code, overrides = {}) => spawnSync(process.execPath, ["--input-type=module", "-e", code], {
		cwd: ENGINE, env: { ...env, ...overrides }, encoding: "utf8", timeout: 10_000,
	});
	const manifest = expected => {
		const path = join(data.root, "configuration.guard.json");
		writeFileSync(path, JSON.stringify({ expected }), { flag: "wx", mode: 0o600 });
		assert.equal(statSync(path).mode & 0o777, 0o600);
		return { HARNESS_CONFIGURATION_WRITE_GUARD: path };
	};
	try { return callback({ ...data, env, child, manifest }); }
	finally { data.restoreEnvironment(); rmSync(data.root, { recursive: true, force: true }); }
}

function succeeded(result) {
	assert.equal(result.error, undefined);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

for (const kind of ["file-content", "file-mode", "missing", "symlink"]) {
	test(`Write-time manifest rejects ${kind} destination changes after snapshot`, () => fixture(({ root, repo, child, manifest }) => {
		const path = join(repo, "guarded-output"), oldText = "approved bytes\n", newText = "external bytes\n";
		let expected;
		if (kind === "missing") expected = { type: "missing" };
		else if (kind === "symlink") {
			symlinkSync(join(root, "approved-target"), path);
			expected = { type: "symlink", value: join(root, "approved-target") };
		} else {
			writeFileSync(path, oldText, { mode: 0o600 });
			expected = { type: "file", content: Buffer.from(oldText).toString("base64"), mode: 0o600 };
		}
		const guardEnv = manifest({ [path]: expected });
		const mutation = kind === "symlink" ? `rmSync(path); symlinkSync(${JSON.stringify(join(root, "external-target"))}, path);`
			: kind === "file-mode" ? "chmodSync(path, 0o644);" : `writeFileSync(path, ${JSON.stringify(newText)}, { mode: 0o600 });`;
		succeeded(child(`
			import assert from 'node:assert/strict';
			import { chmodSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
			import { assertConfigurationWrite } from ${JSON.stringify(guardModule)};
			const path = ${JSON.stringify(path)}, root = ${JSON.stringify(repo)};
			assertConfigurationWrite(path, root);
			assert.throws(() => assertConfigurationWrite(path + '-unapproved', root), { code: 'ECHANGED' });
			${mutation}
			assert.throws(() => assertConfigurationWrite(path, root), { code: 'ECHANGED' });
		`, guardEnv));
		if (kind === "file-mode") assert.equal(statSync(path).mode & 0o777, 0o644);
		else if (kind === "symlink") { assert.equal(lstatSync(path).isSymbolicLink(), true); assert.equal(readlinkSync(path), join(root, "external-target")); }
		else assert.equal(readFileSync(path, "utf8"), newText);
	}));
}

test("Write-time guard rejects a parent replaced by a symlink even when destination bytes match", () => fixture(({ root, repo, child, manifest }) => {
	const parent = join(repo, "generated"), path = join(parent, "output.json"), outside = join(root, "outside");
	mkdirSync(parent); mkdirSync(outside);
	const text = "same approved bytes\n";
	writeFileSync(path, text, { mode: 0o600 }); writeFileSync(join(outside, "output.json"), text, { mode: 0o600 });
	const guardEnv = manifest({ [path]: { type: "file", content: Buffer.from(text).toString("base64"), mode: 0o600 } });
	succeeded(child(`
		import assert from 'node:assert/strict';
		import { renameSync, symlinkSync } from 'node:fs';
		import { assertConfigurationWrite } from ${JSON.stringify(guardModule)};
		const path = ${JSON.stringify(path)}, root = ${JSON.stringify(repo)};
		assertConfigurationWrite(path, root);
		renameSync(${JSON.stringify(parent)}, ${JSON.stringify(`${parent}-saved`)});
		symlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(parent)});
		assert.throws(() => assertConfigurationWrite(path, root), /parent changed or is a symlink/);
	`, guardEnv));
	assert.equal(readFileSync(join(outside, "output.json"), "utf8"), text);
	assert.equal(readFileSync(join(`${parent}-saved`, "output.json"), "utf8"), text);
	assert.deepEqual(readdirSync(outside), ["output.json"]);
}));

test("Actual compose atomicWrite creates missing outputs privately without leftover temporary files", () => fixture(({ repo, child }) => {
	assert.equal(existsSync(join(repo, "AGENTS.md")), false);
	succeeded(child(`
		import assert from 'node:assert/strict';
		import { run, compose } from ${JSON.stringify(composeModule)};
		import { readFileSync, statSync, existsSync } from 'node:fs';
		assert.equal(run({ apply: true }), 0);
		const outputs = compose().outputs;
		assert.equal(outputs.size, 8);
		for (const [path, content] of outputs) {
			assert.equal(readFileSync(path, 'utf8'), content);
			assert.equal(statSync(path).mode & 0o777, 0o600);
			assert.equal(existsSync(path + '.tmp-' + process.pid + '-compose'), false);
		}
	`));
}));

test("Actual compose atomicWrite preserves an external edit made after its destination snapshot", () => fixture(({ repo, child }) => {
	const path = join(repo, "AGENTS.md"), external = "external generated-file change\n";
	writeFileSync(path, "old generated bytes\n", { mode: 0o600 });
	succeeded(child(`
		import assert from 'node:assert/strict';
		import fs from 'node:fs';
		import { syncBuiltinESMExports } from 'node:module';
		const path = ${JSON.stringify(path)}, temporary = path + '.tmp-' + process.pid + '-compose';
		const write = fs.writeFileSync;
		let injected = false;
		fs.writeFileSync = (target, ...args) => {
			const result = write(target, ...args);
			if (target === temporary) { injected = true; write(path, ${JSON.stringify(external)}); }
			return result;
		};
		syncBuiltinESMExports();
		const { run } = await import(${JSON.stringify(composeModule)});
		assert.throws(() => run({ apply: true }), { code: 'ECHANGED' });
		assert.equal(injected, true);
		assert.equal(fs.readFileSync(path, 'utf8'), ${JSON.stringify(external)});
		assert.equal(fs.existsSync(temporary), false);
	`));
	assert.equal(readFileSync(path, "utf8"), external);
}));

test("Actual compose atomicWrite preserves both destination and a colliding temporary file", () => fixture(({ repo, child }) => {
	const path = join(repo, "AGENTS.md"), oldText = "old destination bytes\n", collision = "external temporary bytes\n";
	writeFileSync(path, oldText, { mode: 0o600 });
	succeeded(child(`
		import assert from 'node:assert/strict';
		import { writeFileSync, readFileSync } from 'node:fs';
		import { run } from ${JSON.stringify(composeModule)};
		const path = ${JSON.stringify(path)}, temporary = path + '.tmp-' + process.pid + '-compose';
		writeFileSync(temporary, ${JSON.stringify(collision)}, { flag: 'wx', mode: 0o600 });
		assert.throws(() => run({ apply: true }), { code: 'EEXIST' });
		assert.equal(readFileSync(path, 'utf8'), ${JSON.stringify(oldText)});
		assert.equal(readFileSync(temporary, 'utf8'), ${JSON.stringify(collision)});
	`));
	assert.equal(readFileSync(path, "utf8"), oldText);
	assert.equal(readdirSync(repo).filter(name => name.startsWith("AGENTS.md.tmp-")).length, 1);
}));

test("Actual bootstrap rejects a stale expected settings hash without overwriting concurrent native settings or auth", () => fixture(({ home, env }) => {
	const directory = join(home, ".pi/agent"), settings = join(directory, "settings.json"), auth = join(directory, "auth.json");
	mkdirSync(directory, { recursive: true });
	const oldText = '{"packages":[],"skills":[],"theme":"approved-theme"}\n';
	const external = '{"packages":["./external-local-resource"],"skills":[],"theme":"external-theme"}\n';
	const authBytes = '{"synthetic":"private-auth-fixture-only"}\n';
	writeFileSync(settings, oldText, { mode: 0o600 }); writeFileSync(auth, authBytes, { mode: 0o600 });
	const expectedHash = digest(readFileSync(settings, "utf8"));
	writeFileSync(settings, external);
	const result = spawnSync(process.execPath, [join(ENGINE, "scripts/bootstrap.mjs"), "--apply"], {
		cwd: ENGINE, env: { ...env, HARNESS_EXPECTED_PI_SETTINGS_HASH: expectedHash }, encoding: "utf8", timeout: 10_000,
	});
	assert.equal(result.error, undefined); assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Native Pi settings changed during synchronization; stopped without replacing them/);
	assert.match(result.stderr, /ECHANGED/);
	assert.equal(readFileSync(settings, "utf8"), external); assert.equal(statSync(settings).mode & 0o777, 0o600);
	assert.equal(readFileSync(auth, "utf8"), authBytes);
	assert.equal(readdirSync(directory).some(name => name.startsWith("settings.json.tmp-")), false);
	assert.equal(existsSync(join(directory, "npm")), false);
}));
