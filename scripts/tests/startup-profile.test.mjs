import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { acquireCatalogLock, releaseCatalogLock } from "../../adapters/pi/extensions/harness-manager-state.mjs";
import { runStartupProfile } from "../lib/startup-profile.mjs";

const digest = text => createHash("sha256").update(text).digest("hex");

function fixture(action) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-startup-profile-")));
	const home = join(root, "home"), catalog = join(root, "catalog"), engine = join(root, "engine");
	for (const path of [home, engine, join(catalog, "profiles")]) mkdirSync(path, { recursive: true });
	for (const name of ["medium", "heavy"]) writeFileSync(join(catalog, "profiles", `${name}.json`), JSON.stringify({ name }));
	const directory = join(home, ".local/state/harness/startup-profile");
	const file = join(directory, `${digest(catalog)}.json`);
	const invoke = options => runStartupProfile({ home, catalog, engine, ...options });
	const configure = (profile, expectedHash = invoke().preferencesHash) => invoke({ operation: "configure", profile, expectedHash });
	const putState = text => { mkdirSync(directory, { recursive: true }); writeFileSync(file, text); };
	try { return action({ root, home, catalog, engine, directory, file, invoke, configure, putState }); }
	finally { rmSync(root, { recursive: true, force: true }); }
}

function rejected(result, status = 400) {
	assert.equal(result.ok, false, JSON.stringify(result));
	assert.equal(result.status, status, JSON.stringify(result));
	assert.equal(Object.hasOwn(result, "profile"), true);
	assert.equal(Object.hasOwn(result, "preferencesHash"), true);
	assert.equal(typeof result.missing, "boolean");
	assert.match(result.error, /[\u4e00-\u9fff]/);
}

function tree(path) {
	return readdirSync(path).sort().flatMap(name => {
		const file = join(path, name), stat = lstatSync(file);
		return stat.isDirectory() ? [name + "/", ...tree(file).map(child => `${name}/${child}`)] : [name];
	});
}

test("Absent preference means ordinary Pi; status creates no files or locks and does not inspect native auth", () => fixture(({ home, catalog, engine, invoke }) => {
	mkdirSync(join(home, ".pi/agent"), { recursive: true });
	symlinkSync(join(home, "never-read-auth"), join(home, ".pi/agent/auth.json"));
	const before = [home, catalog, engine].map(tree);
	assert.deepEqual(invoke(), { ok: true, status: 200, profile: null, preferencesHash: digest("missing"), missing: false });
	assert.deepEqual(invoke(), invoke());
	assert.deepEqual([home, catalog, engine].map(tree), before);
}));

test("Named preference persists privately; resetting is explicit null, not the reserved default ID", () => fixture(({ file, directory, invoke, configure }) => {
	const initial = invoke();
	const saved = configure("medium", initial.preferencesHash);
	assert.equal(saved.ok, true, JSON.stringify(saved));
	assert.equal(saved.profile, "medium"); assert.equal(saved.missing, false);
	assert.deepEqual(invoke(), saved);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { schemaVersion: 1, profile: "medium" });
	assert.equal(saved.preferencesHash, digest(readFileSync(file, "utf8")));
	assert.equal(lstatSync(file).mode & 0o777, 0o600);
	assert.equal(lstatSync(directory).mode & 0o777, 0o700);
	assert.deepEqual(readdirSync(directory), [file.split("/").at(-1)]);
	chmodSync(file, 0o644);
	const reset = configure(null, saved.preferencesHash);
	assert.equal(reset.ok, true); assert.equal(reset.profile, null);
	assert.notEqual(reset.preferencesHash, initial.preferencesHash, "saved null is not absent state");
	assert.equal(lstatSync(file).mode & 0o777, 0o600);
	assert.deepEqual(invoke(), reset);
}));

test("Canonical Catalog aliases share preferences; different Catalogs have separate defaults; canonical HOME aliases work", () => fixture(({ root, home, catalog, invoke, configure }) => {
	const other = join(root, "other-catalog"); mkdirSync(join(other, "profiles"), { recursive: true });
	writeFileSync(join(other, "profiles/heavy.json"), "{}");
	const catalogAlias = join(root, "catalog-alias"), homeAlias = join(root, "home-alias");
	symlinkSync(catalog, catalogAlias); symlinkSync(home, homeAlias);
	assert.equal(configure("medium").ok, true);
	assert.equal(invoke({ catalog: catalogAlias, home: homeAlias }).profile, "medium");
	const initialOther = invoke({ catalog: other }); assert.equal(initialOther.profile, null);
	const savedOther = invoke({ catalog: other, operation: "configure", profile: "heavy", expectedHash: initialOther.preferencesHash });
	assert.equal(savedOther.ok, true); assert.equal(invoke({ catalog: other }).profile, "heavy");
	assert.equal(invoke().profile, "medium");
	assert.equal(existsSync(join(home, ".local/state/harness/startup-profile", `${digest(other)}.json`)), true);
}));

test("CAS hashes exact file text, rejects stale/missing versions and preserves concurrent edits", () => fixture(({ file, invoke, configure }) => {
	const absent = invoke(); const saved = configure("medium");
	rejected(configure("heavy", absent.preferencesHash), 409);
	const external = '{"profile":"medium","schemaVersion":1}\n'; writeFileSync(file, external);
	rejected(configure("heavy", saved.preferencesHash), 409);
	assert.equal(readFileSync(file, "utf8"), external);
	assert.equal(invoke().preferencesHash, digest(external));
	assert.equal(configure("heavy").ok, true);
	const beforeRemoval = invoke(); rmSync(file);
	rejected(configure(null, beforeRemoval.preferencesHash), 409);
	assert.equal(existsSync(file), false);
}));

test("Atomic replacement rechecks byte CAS, source existence and state type immediately before writing", () => {
	for (const change of ["preference", "source", "symlink"]) fixture(({ root, catalog, directory, file, configure }) => {
		const saved = configure(null); assert.equal(saved.ok, true);
		const initial = readFileSync(file, "utf8");
		const external = '{"schemaVersion":1,"profile":"heavy"}\n';
		const target = join(root, "external-state.json"); writeFileSync(target, external);
		const originalWrite = fs.writeFileSync;
		fs.writeFileSync = (path, ...args) => {
			const value = originalWrite(path, ...args);
			if (typeof path === "string" && path.startsWith(`${file}.tmp-${process.pid}-startup-profile-`)) {
				if (change === "preference") originalWrite(file, external);
				else if (change === "source") rmSync(join(catalog, "profiles/medium.json"));
				else { rmSync(file); symlinkSync(target, file); }
			}
			return value;
		};
		syncBuiltinESMExports();
		try { rejected(configure("medium", saved.preferencesHash), change === "preference" ? 409 : change === "source" ? 404 : 400); }
		finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); }
		assert.equal(readFileSync(file, "utf8"), change === "source" ? initial : external);
		assert.equal(readFileSync(target, "utf8"), external);
		const artifacts = readdirSync(directory).filter(name => name !== file.split("/").at(-1));
		assert.equal(artifacts.some(name => name.endsWith(".harness.lock")), false);
		if (change === "preference") assert.deepEqual(artifacts, []);
		else {
			assert.equal(artifacts.length, 1, "atomicWrite retains private temporary evidence when its guard rejects cleanup");
			assert.equal(lstatSync(join(directory, artifacts[0])).mode & 0o777, 0o600);
			if (change === "source") assert.equal(configure(null).ok, true, "retained temporary evidence does not block future saves");
		}
	});
});

test("A state parent swapped during temporary writing is refused; lock cleanup never traverses the new link", () => fixture(({ root, directory, file, configure }) => {
	const saved = configure(null); assert.equal(saved.ok, true);
	const outside = join(root, "outside"), moved = join(root, "moved-state"); mkdirSync(outside);
	const externalFile = join(outside, file.split("/").at(-1));
	writeFileSync(externalFile, '{"schemaVersion":1,"profile":"heavy"}');
	writeFileSync(`${externalFile}.harness.lock`, "external lock owner\n");
	const outsideBefore = tree(outside), contentBefore = readFileSync(externalFile);
	const originalWrite = fs.writeFileSync;
	fs.writeFileSync = (path, ...args) => {
		const value = originalWrite(path, ...args);
		if (typeof path === "string" && path.startsWith(`${file}.tmp-${process.pid}-startup-profile-`)) {
			fs.renameSync(directory, moved); symlinkSync(outside, directory);
		}
		return value;
	};
	syncBuiltinESMExports();
	try { rejected(configure("medium", saved.preferencesHash)); }
	finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); }
	assert.equal(lstatSync(directory).isSymbolicLink(), true);
	assert.deepEqual(tree(outside), outsideBefore); assert.deepEqual(readFileSync(externalFile), contentBefore);
	assert.equal(readFileSync(`${externalFile}.harness.lock`, "utf8"), "external lock owner\n");
	assert.equal(readdirSync(moved).some(name => name.includes(".tmp-")), true, "original private temporary evidence is retained");
}));

test("Deleted selected sources remain selected and missing; status never rewrites or silently falls back", () => fixture(({ catalog, file, invoke, configure }) => {
	assert.equal(configure("medium").ok, true);
	const original = readFileSync(file, "utf8"), hash = invoke().preferencesHash;
	rmSync(join(catalog, "profiles/medium.json"));
	const missing = invoke(); assert.equal(missing.ok, true); assert.equal(missing.profile, "medium"); assert.equal(missing.missing, true);
	assert.equal(missing.preferencesHash, hash); assert.equal(readFileSync(file, "utf8"), original);
	rejected(configure("medium", hash), 404);
	assert.equal(readFileSync(file, "utf8"), original);
	rmSync(join(catalog, "profiles"), { recursive: true });
	assert.equal(invoke().missing, true);
	assert.equal(configure(null, hash).ok, true, "reset can repair a selection whose entire source directory is gone");
}));

test("Configure requires an explicit safe Profile or null, a hash, and a known operation", () => fixture(({ invoke, configure, directory }) => {
	for (const profile of [undefined, "", "default", "DEFAULT", "profile.schema", "PROFILE.SCHEMA", "../medium", "/medium", "a/b", "a\\b", ".", "..", "a\0b", " medium", "a".repeat(201), {}, [], 0, false]) {
		rejected(configure(profile));
	}
	for (const expectedHash of [undefined, null, "", "not-a-hash", "f".repeat(63), "F".repeat(64), 1]) {
		rejected(invoke({ operation: "configure", profile: null, expectedHash }));
	}
	rejected(invoke({ operation: "delete" }));
	rejected(configure("unknown"), 404);
	assert.equal(existsSync(directory), false, "invalid operations do not create state directories");
}));

test("Existing safe IDs accepted by isProfileName include case, dots, hyphens and underscores", () => fixture(({ catalog, configure }) => {
	for (const profile of ["A", "work.v2", "work-heavy", "work_light"]) {
		writeFileSync(join(catalog, "profiles", `${profile}.json`), "{}");
		assert.equal(configure(profile).ok, true, profile);
	}
}));

test("Source JSON must be a bounded object and a regular nonsymlink file", () => {
	for (const text of ["{", "null", "[]", "1", '"object"', " ".repeat(1024 * 1024 + 1)]) fixture(({ catalog, configure, directory }) => {
		writeFileSync(join(catalog, "profiles/medium.json"), text);
		rejected(configure("medium"));
		assert.equal(existsSync(directory), false);
	});
	for (const type of ["directory", "symlink", "dangling"]) fixture(({ root, catalog, configure, directory }) => {
		const source = join(catalog, "profiles/medium.json"); rmSync(source);
		const target = join(root, "external.json"); writeFileSync(target, "{}");
		if (type === "directory") mkdirSync(source);
		else symlinkSync(type === "dangling" ? join(root, "absent") : target, source);
		rejected(configure("medium"));
		assert.equal(readFileSync(target, "utf8"), "{}"); assert.equal(existsSync(directory), false);
	});
});

test("Status fails closed if a saved Profile source becomes invalid or a dangling symlink", () => fixture(({ root, catalog, file, invoke, configure }) => {
	assert.equal(configure("medium").ok, true); const preference = readFileSync(file, "utf8");
	const source = join(catalog, "profiles/medium.json");
	writeFileSync(source, "[]"); rejected(invoke()); assert.equal(invoke().profile, "medium");
	rmSync(source); symlinkSync(join(root, "absent-source"), source);
	rejected(invoke()); assert.equal(readFileSync(file, "utf8"), preference);
}));

test("Preference JSON has a bounded strict schema; corrupt state is not ordinary mode and cannot be overwritten", () => {
	for (const text of ["{", "null", "[]", "{}", '{"schemaVersion":1}', '{"schemaVersion":2,"profile":null}',
		'{"schemaVersion":1,"profile":null,"extra":true}', '{"schemaVersion":1,"profile":false}',
		'{"schemaVersion":1,"profile":"default"}', '{"schemaVersion":1,"profile":"../medium"}',
		JSON.stringify({ schemaVersion: 1, profile: "a".repeat(201) }), " ".repeat(4097), Buffer.from([0xff])]) fixture(({ file, invoke, putState }) => {
		putState(text); const before = readFileSync(file);
		rejected(invoke());
		rejected(invoke({ operation: "configure", profile: null, expectedHash: digest(before) }));
		assert.deepEqual(readFileSync(file), before);
	});
});

test("State files cannot be directories, symlinks or dangling symlinks", () => {
	for (const type of ["directory", "symlink", "dangling"]) fixture(({ root, directory, file, invoke }) => {
		mkdirSync(directory, { recursive: true });
		const target = join(root, "external-state.json"), text = '{"schemaVersion":1,"profile":null}'; writeFileSync(target, text);
		if (type === "directory") mkdirSync(file);
		else symlinkSync(type === "dangling" ? join(root, "absent-state") : target, file);
		rejected(invoke());
		rejected(invoke({ operation: "configure", profile: null, expectedHash: digest("missing") }));
		assert.equal(readFileSync(target, "utf8"), text);
		assert.equal(readdirSync(directory).length, 1, "no temporary files or locks created");
	});
});

test("Every local state parent rejects existing and dangling links before any write", () => {
	for (const suffix of [".local", ".local/state", ".local/state/harness", ".local/state/harness/startup-profile"]) {
		for (const dangling of [false, true]) fixture(({ root, home, invoke }) => {
			const parent = join(home, suffix), outside = join(root, "outside"); mkdirSync(dirname(parent), { recursive: true });
			if (!dangling) mkdirSync(outside);
			symlinkSync(outside, parent);
			rejected(invoke()); rejected(invoke({ operation: "configure", profile: null, expectedHash: digest("missing") }));
			assert.equal(lstatSync(parent).isSymbolicLink(), true);
			if (!dangling) assert.deepEqual(readdirSync(outside), []);
		});
	}
});

test("Linked source directories are refused even in ordinary mode", () => {
	for (const dangling of [false, true]) fixture(({ root, catalog, invoke }) => {
		const profiles = join(catalog, "profiles"), outside = join(root, "outside-profiles"); rmSync(profiles, { recursive: true });
		if (!dangling) { mkdirSync(outside); writeFileSync(join(outside, "medium.json"), "{}"); }
		symlinkSync(outside, profiles);
		rejected(invoke()); rejected(invoke({ operation: "configure", profile: "medium", expectedHash: digest("missing") }));
		assert.equal(lstatSync(profiles).isSymbolicLink(), true);
	});
});

test("Preference location cannot be within canonical Catalog or Engine", () => fixture(({ root, catalog, engine, invoke }) => {
	for (const home of [catalog, engine]) {
		rejected(invoke({ home }));
		rejected(invoke({ home, operation: "configure", profile: null, expectedHash: digest("missing") }));
		assert.equal(existsSync(join(home, ".local")), false);
	}
	const alias = join(root, "repo-home"); symlinkSync(catalog, alias);
	rejected(invoke({ home: alias }));
}));

test("Configure cooperates with exact Catalog transaction, source and preference-file locks; status ignores locks", () => fixture(({ catalog, file, invoke, configure }) => {
	const saved = configure("medium"); assert.equal(saved.ok, true);
	const original = readFileSync(file, "utf8");
	for (const source of [join(catalog, ".catalog"), join(catalog, "profiles/heavy.json"), file]) {
		const lock = acquireCatalogLock(source);
		try {
			assert.equal(invoke().ok, true, "status does not acquire or change locks");
			rejected(configure("heavy", saved.preferencesHash), 423);
			assert.equal(readFileSync(file, "utf8"), original);
			assert.equal(existsSync(lock.path), true, "another owner's lock is not removed");
		} finally { releaseCatalogLock(lock); }
		assert.equal(existsSync(`${join(catalog, ".catalog")}.harness.lock`), false);
		assert.equal(existsSync(`${join(catalog, "profiles/heavy.json")}.harness.lock`), false);
		assert.equal(existsSync(`${file}.harness.lock`), false);
	}
	assert.equal(configure("heavy", saved.preferencesHash).ok, true);
}));

test("Preference saves leave Catalog, native settings/auth and current runtime state byte-for-byte unchanged", () => fixture(({ home, catalog, engine, invoke, configure }) => {
	const files = [join(home, ".pi/agent/settings.json"), join(home, ".pi/agent/auth.json"),
		join(home, ".pi-profile-switch/settings.json"), join(home, ".pi-profile-switch/current.json"),
		join(catalog, "adapters/pi/settings.json"), join(engine, "settings.json")];
	for (const [index, file] of files.entries()) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ fixture: index })); }
	const snapshots = files.map(file => readFileSync(file));
	const catalogTree = tree(catalog), engineTree = tree(engine);
	assert.equal(configure("medium").ok, true); assert.equal(configure("heavy").ok, true); assert.equal(configure(null).ok, true); assert.equal(invoke().ok, true);
	files.forEach((file, index) => assert.deepEqual(readFileSync(file), snapshots[index]));
	assert.deepEqual(tree(catalog), catalogTree); assert.deepEqual(tree(engine), engineTree);
	assert.equal(readFileSync(join(catalog, "profiles/medium.json"), "utf8"), '{"name":"medium"}');
	assert.equal(readFileSync(join(catalog, "profiles/heavy.json"), "utf8"), '{"name":"heavy"}');
}));
