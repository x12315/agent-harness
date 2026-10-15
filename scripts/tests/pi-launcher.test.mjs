import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE, catalogArguments, pins } from "../lib/repo.mjs";
import { runStartupProfile } from "../lib/startup-profile.mjs";
import { hashText } from "../lib/web-catalog.mjs";
import { createWebFixture } from "./web-fixture.mjs";

function fixture({ compiled = false } = {}) {
  const root = realpathSync(createWebFixture());
  const home = realpathSync(mkdtempSync(join(tmpdir(), "harness-pi-launcher-home-"))), bin = join(root, "bin");
  const cleanup = () => { for (const path of [root, home]) rmSync(path, { recursive: true, force: true }); };
  try {
    for (const dir of [bin, join(root, "adapters/pi/profiles"), join(home, ".pi/agent/extensions"), join(home, ".pi-profile-switch"), join(root, "npm/pi-profile-switch")]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    symlinkSync(join(ENGINE, "adapters/pi/extensions/harness-manager.ts"), join(home, ".pi/agent/extensions/harness-manager.ts"));
    symlinkSync(join(root, "adapters/pi/profiles"), join(home, ".pi-profile-switch/profiles"));
    writeFileSync(join(root, "AGENTS.md"), "Fixture global rules.\n");
    symlinkSync(join(root, "AGENTS.md"), join(home, ".pi/agent/AGENTS.md"));
    const settings = join(home, ".pi/agent/settings.json");
    writeFileSync(settings, JSON.stringify({ skills: [`-${home}/.pi/agent/skills/profile-config/SKILL.md`], theme: "light", enabledModels: ["fixture/*"] }));
    writeFileSync(join(root, "npm/pi-profile-switch/package.json"), JSON.stringify({ version: pins().piProfileSwitch }));
    writeFileSync(join(bin, "npm"), `#!/bin/sh\nprintf '%s\\n' '${root}/npm'\n`, { mode: 0o755 });
    writeFileSync(join(bin, "pi-profile"), `#!${process.execPath}\nimport {readFileSync} from 'node:fs';\nconsole.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),catalog:process.env.HARNESS_CATALOG,input:readFileSync(0,'utf8')}));console.error('native stderr');process.exit(7);\n`, { mode: 0o755 });
    const env = { ...process.env, HOME: home, HARNESS_CATALOG: root, PATH: `${bin}:${process.env.PATH}` };
    delete env.PI_CODING_AGENT_DIR;
    delete env.PI_PROFILE_SWITCH_DIR;
    if (compiled) {
      const result = spawnSync(process.execPath, [join(ENGINE, "bin/harness"), "compose", "--apply"], { env, cwd: root, encoding: "utf8", timeout: 15_000 });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
    }
    const preference = join(home, ".local/state/harness/startup-profile", `${hashText(root)}.json`);
    const startup = options => runStartupProfile({ catalog: root, home, ...options });
    const configure = profile => {
      const current = startup();
      assert.equal(current.ok, true, JSON.stringify(current));
      const result = startup({ operation: "configure", profile, expectedHash: current.preferencesHash });
      assert.equal(result.ok, true, JSON.stringify(result));
      return result;
    };
    return { root, home, bin, settings, env, preference, startup, configure, cleanup };
  } catch (error) { cleanup(); throw error; }
}

test("Pi launch arguments are opaque; Catalog selection must precede the command", () => {
  const args = ["pi", "--model", "a/b", "--", "--catalog=/prompt-not-a-catalog"];
  assert.deepEqual(catalogArguments(args, { HOME: "/unused" }).args, args);
  assert.deepEqual(catalogArguments(["--catalog=/data", ...args], { HOME: "/unused" }).args, args);
});

test("Both entries forward native arguments, cwd, stdin/stdout/stderr and exit status without writes", () => {
  const f = fixture();
  try {
    const before = readFileSync(f.settings, "utf8");
    const piArgs = ["-h", "--mode", "rpc", "--", "--catalog=/prompt path", "hello world"];
    for (const [entry, prefix] of [["bin/pi-h", []], ["bin/harness", [`--catalog=${f.root}`, "pi"]]]) {
      const result = spawnSync(process.execPath, [join(ENGINE, entry), ...prefix, ...piArgs], { env: f.env, cwd: f.root, input: "native stdin\n", encoding: "utf8", timeout: 15_000 });
      assert.ifError(result.error);
      assert.equal(result.status, 7, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { args: ["default", "--", "--extension", join(f.home, ".pi/agent/extensions/harness-manager.ts"), ...piArgs], cwd: f.root, catalog: f.root, input: "native stdin\n" });
      assert.equal(result.stderr, "native stderr\n");
      assert.equal(readFileSync(f.settings, "utf8"), before);
    }
  } finally { f.cleanup(); }
});

test("Configured startup profile selects medium; explicit null restores ordinary startup without settings writes", () => {
  const f = fixture({ compiled: true });
  try {
    const beforeSettings = readFileSync(f.settings, "utf8");
    const piArgs = ["medium", "--model", "openai/gpt-5.2", "--thinking", "high", "--", "--catalog=/literal", "heavy"];
    for (const profile of ["medium", null]) {
      f.configure(profile);
      const beforePreference = readFileSync(f.preference, "utf8");
      for (const [entry, prefix] of [["bin/pi-h", []], ["bin/harness", [`--catalog=${f.root}`, "pi"]]]) {
        const result = spawnSync(process.execPath, [join(ENGINE, entry), ...prefix, ...piArgs], { env: f.env, cwd: f.root, input: "native stdin\n", encoding: "utf8", timeout: 15_000 });
        assert.ifError(result.error);
        assert.equal(result.status, 7, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), { args: [profile ?? "default", "--", "--extension", join(f.home, ".pi/agent/extensions/harness-manager.ts"), ...piArgs], cwd: f.root, catalog: f.root, input: "native stdin\n" });
        assert.equal(result.stderr, "native stderr\n");
        assert.equal(readFileSync(f.settings, "utf8"), beforeSettings);
        assert.equal(readFileSync(f.preference, "utf8"), beforePreference, "launch must not save another default");
      }
    }
  } finally { f.cleanup(); }
});

test("Invalid preference, missing selected source and absent or stale generated profiles stop before native spawn", () => {
  const cases = [
    ["corrupt preference", f => writeFileSync(f.preference, "{broken")],
    ["missing selected source", f => rmSync(join(f.root, "profiles/medium.json"))],
    ["corrupt selected source", f => writeFileSync(join(f.root, "profiles/medium.json"), "{broken")],
    ["absent generated profile", f => rmSync(join(f.root, "adapters/pi/profiles/medium.json"))],
    ["corrupt generated profile", f => writeFileSync(join(f.root, "adapters/pi/profiles/medium.json"), "{broken")],
    ["non-exact generated profile", f => {
      const path = join(f.root, "adapters/pi/profiles/medium.json");
      writeFileSync(path, readFileSync(path, "utf8") + "\n");
    }],
    ["stale generated profile", f => {
      const path = join(f.root, "profiles/medium.json"), source = JSON.parse(readFileSync(path, "utf8"));
      source.adapters.pi.tools = [];
      writeFileSync(path, JSON.stringify(source));
    }],
  ];
  for (const [name, change] of cases) {
    const f = fixture({ compiled: true });
    try {
      f.configure("medium");
      change(f);
      const beforeSettings = readFileSync(f.settings, "utf8"), beforePreference = readFileSync(f.preference, "utf8");
      const result = spawnSync(process.execPath, [join(ENGINE, "bin/pi-h")], { env: f.env, cwd: f.root, input: "", encoding: "utf8", timeout: 15_000 });
      assert.ifError(result.error);
      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      assert.match(result.stderr, /pi-h:/, name);
      assert.equal(result.stdout, "", `${name}: must not spawn the native launcher`);
      assert.equal(readFileSync(f.settings, "utf8"), beforeSettings);
      assert.equal(readFileSync(f.preference, "utf8"), beforePreference, "must not silently reset invalid defaults");
    } finally { f.cleanup(); }
  }
});

test("Explicit harness run pi profile overrides the saved startup default", () => {
  const f = fixture({ compiled: true });
  try {
    f.configure("medium");
    const beforeSettings = readFileSync(f.settings, "utf8"), beforePreference = readFileSync(f.preference, "utf8");
    const args = ["--model", "openai/gpt-5.2", "--", "medium"];
    const result = spawnSync(process.execPath, [join(ENGINE, "bin/harness"), `--catalog=${f.root}`, "run", "pi", "heavy", ...args], { env: f.env, cwd: f.root, input: "explicit stdin\n", encoding: "utf8", timeout: 15_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 7, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { args: ["heavy", "--", ...args], cwd: f.root, catalog: f.root, input: "explicit stdin\n" });
    assert.equal(readFileSync(f.settings, "utf8"), beforeSettings);
    assert.equal(readFileSync(f.preference, "utf8"), beforePreference);
  } finally { f.cleanup(); }
});

test("Trust-looking arguments fail closed instead of turning literal prompt text into approval", () => {
  const f = fixture();
  try {
    for (const flag of ["--approve", "-a", "--no-approve", "-na"]) {
      for (const args of [[flag], ["--", flag], ["--append-system-prompt", flag]]) {
        const result = spawnSync(process.execPath, [join(ENGINE, "bin/pi-h"), ...args], { env: f.env, cwd: f.root, input: "", encoding: "utf8", timeout: 15_000 });
        assert.ifError(result.error);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /trust arguments are not supported/);
        assert.equal(result.stdout, "", "must not launch Pi or change its trust policy");
      }
    }
  } finally { f.cleanup(); }
});

test("Direct SIGINT/SIGTERM reach the native launcher and return its exit code", { timeout: 30_000 }, async () => {
  for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    const f = fixture();
    let child, nativePid;
    try {
      writeFileSync(join(f.bin, "pi-profile"), `#!${process.execPath}\nprocess.on('SIGINT',()=>process.exit(130));process.on('SIGTERM',()=>process.exit(143));console.log(process.pid);setInterval(()=>{},1000);\n`);
      child = spawn(process.execPath, [join(ENGINE, "bin/pi-h")], { env: f.env, cwd: f.root, stdio: ["pipe", "pipe", "pipe"] });
      const closed = new Promise(resolve => child.once("close", code => resolve(code)));
      await new Promise((resolve, reject) => { child.once("error", reject); child.stdout.once("data", data => { nativePid = Number(data.toString().trim()); resolve(); }); });
      child.kill(signal);
      assert.equal(await closed, exitCode);
      assert.throws(() => process.kill(nativePid, 0), { code: "ESRCH" });
    } finally {
      child?.kill("SIGKILL");
      if (nativePid) { try { process.kill(nativePid, "SIGKILL"); } catch { /* already exited */ } }
      f.cleanup();
    }
  }
});

test("Launch fails closed on missing dependencies, version drift, foreign projections, unsafe settings and nested runtime", () => {
  const cases = [
    [f => rmSync(join(f.bin, "pi-profile")), /pi-profile is not installed/],
    [f => writeFileSync(join(f.root, "npm/pi-profile-switch/package.json"), '{"version":"0.0.0"}'), /version differs/],
    [f => { rmSync(join(f.home, ".pi-profile-switch/profiles")); symlinkSync(f.root, join(f.home, ".pi-profile-switch/profiles")); }, /projections do not match/],
    [f => { rmSync(join(f.home, ".pi/agent/AGENTS.md")); symlinkSync(f.settings, join(f.home, ".pi/agent/AGENTS.md")); }, /projections do not match/],
    [f => writeFileSync(f.settings, '{}'), /exclude profile-config/],
    [f => { f.env.PI_CODING_AGENT_DIR = f.root; }, /external terminal/],
    [f => { f.env.PI_PROFILE_SWITCH_DIR = f.root; }, /managed native workspace/],
    [f => writeFileSync(join(f.root, "harness.catalog.json"), '{"schemaVersion":2}'), /Unsupported Catalog/],
  ];
  for (const [change, pattern] of cases) {
    const f = fixture();
    try {
      change(f);
      // Do not let the real global pi-profile mask the deliberately absent stub.
      const env = { ...f.env, PATH: `${f.bin}:/usr/bin:/bin` };
      const result = spawnSync(process.execPath, [join(ENGINE, "bin/pi-h")], { env, cwd: f.root, input: "", encoding: "utf8", timeout: 15_000 });
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, pattern);
      assert.equal(result.stdout, "");
    } finally { f.cleanup(); }
  }
});
