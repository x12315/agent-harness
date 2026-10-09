import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE, catalogArguments, pins } from "../lib/repo.mjs";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-pi-launcher-")));
  const home = join(root, "home"), bin = join(root, "bin");
  for (const dir of [bin, join(root, "adapters/pi/profiles"), join(home, ".pi/agent/extensions"), join(home, ".pi-profile-switch"), join(root, "npm/pi-profile-switch")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, "harness.catalog.json"), '{"schemaVersion":1}');
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
  return { root, home, bin, settings, env };
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
      const result = spawnSync(process.execPath, [join(ENGINE, entry), ...prefix, ...piArgs], { env: f.env, cwd: f.root, input: "native stdin\n", encoding: "utf8", timeout: 5000 });
      assert.equal(result.status, 7, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { args: ["default", "--", "--extension", join(f.home, ".pi/agent/extensions/harness-manager.ts"), ...piArgs], cwd: f.root, catalog: f.root, input: "native stdin\n" });
      assert.equal(result.stderr, "native stderr\n");
      assert.equal(readFileSync(f.settings, "utf8"), before);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("Trust-looking arguments fail closed instead of turning literal prompt text into approval", () => {
  const f = fixture();
  try {
    for (const flag of ["--approve", "-a", "--no-approve", "-na"]) {
      for (const args of [[flag], ["--", flag], ["--append-system-prompt", flag]]) {
        const result = spawnSync(process.execPath, [join(ENGINE, "bin/pi-h"), ...args], { env: f.env, cwd: f.root, input: "", encoding: "utf8", timeout: 5000 });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /trust arguments are not supported/);
        assert.equal(result.stdout, "", "must not launch Pi or change its trust policy");
      }
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("Direct SIGINT/SIGTERM reach the native launcher and return its exit code", { timeout: 10_000 }, async () => {
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
      rmSync(f.root, { recursive: true, force: true });
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
      const result = spawnSync(process.execPath, [join(ENGINE, "bin/pi-h")], { env, cwd: f.root, input: "", encoding: "utf8", timeout: 5000 });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, pattern);
      assert.equal(result.stdout, "");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});
