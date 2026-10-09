import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapChecks, runCheckCommand } from "../lib/check-runner.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("Bounded scheduling preserves order and every result in serial and parallel modes", async () => {
  const values = [40, 5, 20, 10, 5];
  let active = 0;
  let maximum = 0;
  const check = async (ms, index) => {
    active++; maximum = Math.max(maximum, active);
    await delay(ms);
    active--;
    return { index, status: index === 2 ? "fail" : "pass" };
  };
  const serial = await mapChecks(values, check, 1);
  assert.equal(maximum, 1);
  maximum = 0;
  const parallel = await mapChecks(values, check, 3);
  assert.deepEqual(parallel, serial);
  assert.equal(maximum, 3);
  await assert.rejects(mapChecks(values, check, 0));
  await assert.rejects(mapChecks(values, check, 9));
  await assert.rejects(mapChecks(values, () => { throw Error("broken check"); }), /broken check/);
});

test("Async command checks preserve stdin, failures, spawn errors, timeouts and output limits", async () => {
  const echo = await runCheckCommand(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: "RPC input\n", timeout: 1000 });
  assert.equal(echo.status, 0);
  assert.equal(echo.stdout, "RPC input\n");
  const failed = await runCheckCommand(process.execPath, ["-e", "console.error('check failed');process.exit(7)"]);
  assert.equal(failed.status, 7);
  assert.match(failed.stderr, /check failed/);
  const missing = await runCheckCommand("/nonexistent/harness-check-fixture", []);
  assert.notEqual(missing.status, 0);
  const timedOut = await runCheckCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeout: 100, killSignal: "SIGKILL" });
  assert.notEqual(timedOut.status, 0);
  assert.equal(timedOut.error.killed, true);
  const overflow = await runCheckCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], { maxBuffer: 32 });
  assert.notEqual(overflow.status, 0);
});

test("Harness awaits async verification and JSON doctor retains the entire gate", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-check-runner-"));
  try {
    mkdirSync(join(root, "scripts/lib"), { recursive: true });
    copyFileSync(new URL("../lib/repo.mjs", import.meta.url), join(root, "scripts/lib/repo.mjs"));
    copyFileSync(new URL("../harness.mjs", import.meta.url), join(root, "scripts/harness.mjs"));
    for (const name of ["bootstrap", "compose", "drift", "reconcile", "secret-scan", "restore"]) {
      writeFileSync(join(root, `scripts/${name}.mjs`), `import { appendFileSync } from 'node:fs';
export function run(options) {appendFileSync('calls.jsonl',JSON.stringify({name:${JSON.stringify(name)},options})+'\\n');return 0;}
export function nextSteps() {return [];}`);
    }
    writeFileSync(join(root, "scripts/verify.mjs"), `import { appendFileSync } from 'node:fs';
export function verificationOptions() {return {};}
export async function run(options) {await new Promise(r=>setTimeout(r,20));appendFileSync('calls.jsonl',JSON.stringify({name:'verify',options})+'\\n');return 7;}`);
    writeFileSync(join(root, "scripts/manage.mjs"), "export const editProfile=()=>0,help=()=>0,runPi=()=>0,runProfile=()=>0,showProfilePath=()=>0,showProfiles=()=>0,showStatus=()=>0;");
    const trace = join(root, "calls.jsonl");
    for (const args of [["doctor"], ["doctor", "--json"], ["doctor", "--serial"], ["apply"], ["all", "--apply"]]) {
      writeFileSync(trace, "");
      const result = await runCheckCommand(process.execPath, [join(root, "scripts/harness.mjs"), ...args], { cwd: root, timeout: 2000 });
      assert.equal(result.status, 1, `${args}: async verification failure was lost`);
      const calls = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(calls.map((call) => call.name), ["compose", "bootstrap", "reconcile", "secret-scan", "verify"]);
      assert.equal(calls.at(-1).options.serial, args.includes("--serial"));
    }
    const direct = await runCheckCommand(process.execPath, [join(root, "scripts/harness.mjs"), "verify", "--catalog"], { cwd: root });
    assert.equal(direct.status, 7);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
