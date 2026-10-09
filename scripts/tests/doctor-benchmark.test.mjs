import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctorBenchmark } from "../lib/doctor-benchmark.mjs";

function fixture(scenario = "success") {
  const base = mkdtempSync(join(tmpdir(), "harness-benchmark-test-"));
  const repo = join(base, "repo");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "profiles"));
  writeFileSync(join(repo, "profiles/sample.json"), JSON.stringify({ label: "Fixture", description: "Fixture", skills: [], instructions: [], adapters: {} }));
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, ".gitignore"), "*.harness.lock\n");
  writeFileSync(join(repo, "scripts/harness.mjs"), `import { writeFileSync } from 'node:fs';
const args=process.argv.slice(2), scenario=${JSON.stringify(scenario)};
if(args[0]==='status') console.log(JSON.stringify({ok:true,profiles:[{name:'sample'}],skills:{installed:1},runtimes:{piProfileSwitch:'fixture'}}));
else if(args[0]==='compose') console.log(JSON.stringify({ok:true,modules:3}));
else {
 const serial=args.includes('--serial');
 await new Promise(r=>setTimeout(r,serial?12:4));
 const status=scenario==='failure'?'fail':'pass';
 const name=scenario==='coverage-drift'&&!serial?'different':'fixture';
 if(scenario==='source-drift')writeFileSync('profiles/sample.json','{}');
 if(scenario==='engine-drift')writeFileSync(new URL(import.meta.url), '\\n', {flag:'a'});
 console.log('== verify\\n'+JSON.stringify({ok:status==='pass',pid:process.pid,checks:[{name,status,durationMs:1}],durationMs:2}));
 if(scenario==='secret-output')console.error('sk-'+'A'.repeat(40));
 process.exitCode=scenario==='failure'||scenario==='outer-failure'?1:0;
}`);
  mkdirSync(join(repo,"bin"));
  for (const command of ["pi","codex"]) writeFileSync(join(repo,"bin",command), "#!/bin/sh\nprintf 'fixture-version\\n'\n", { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${join(repo,"bin")}:${previousPath}`;
  return { base, repo, engine: repo, out: join(base, "result"), previousPath };
}

const clean = (value) => { process.env.PATH = value.previousPath; rmSync(value.base, { recursive: true, force: true }); };

test("Benchmark executes six fresh full doctors, alternates order, reports scope and preserves evidence", async () => {
  const f = fixture();
  try {
    const result = await runDoctorBenchmark(f);
    assert.equal(result.code, 0, JSON.stringify(result.report.issues));
    assert.equal(result.report.ok, true);
    assert.deepEqual(result.report.samples.map(s=>s.mode), ["serial", "parallel", "parallel", "serial", "serial", "parallel"]);
    assert.equal(result.report.statistics.parallel.samples, 3);
    assert.equal(result.report.workload.instructionEntries, 3);
    const pids = result.report.samples.map(s=>JSON.parse(readFileSync(join(f.out,s.log),'utf8').split('== verify\n')[1]).pid);
    assert.equal(new Set(pids).size, 6, "must not reuse cached doctor results");
    assert.equal(existsSync(join(f.repo, ".catalog.harness.lock")), false);
    await assert.rejects(runDoctorBenchmark(f), /already exists/);
    assert.equal(JSON.parse(readFileSync(join(f.out, "report.json"))).ok, true);
  } finally { clean(f); }
});

test("Doctor failures, coverage drift and source drift cannot become a successful benchmark", async () => {
  for (const scenario of ["failure", "outer-failure", "coverage-drift", "source-drift"]) {
    const f = fixture(scenario);
    try {
      const result = await runDoctorBenchmark(f);
      assert.equal(result.code, 1, scenario);
      assert.equal(result.report.ok, false);
      assert.ok(result.report.issues.length > 0);
      assert.ok(result.report.samples.length < 6);
      assert.equal(JSON.parse(readFileSync(join(f.out, "report.json"))).ok, false);
      assert.equal(existsSync(join(f.repo, ".catalog.harness.lock")), false);
    } finally { clean(f); }
  }
});

test("Explicit median and baseline budgets fail closed; incomparable baselines stop measurement", async () => {
  const f = fixture();
  try {
    const result = await runDoctorBenchmark({ ...f, maxMedianMs: 0.01 });
    assert.equal(result.code, 1);
    assert.match(result.report.issues.join(" "), /median exceeds/);
    const baseline = structuredClone(result.report); baseline.ok = true; baseline.issues = [];
    baseline.statistics.parallel.medianMs = 1;
    const baselinePath = join(f.base, "baseline.json"); writeFileSync(baselinePath, JSON.stringify(baseline));
    const regressed = await runDoctorBenchmark({ ...f, out: join(f.base,"regressed"), baselinePath, maxRegressionPercent: 20 });
    assert.equal(regressed.code, 1);
    assert.equal(regressed.report.comparison.comparable, true);
    assert.match(regressed.report.issues.join(" "), /regression exceeds/);
    baseline.environment.node = "different runtime"; writeFileSync(baselinePath, JSON.stringify(baseline));
    const incomparable = await runDoctorBenchmark({ ...f, out: join(f.base,"incomparable"), baselinePath });
    assert.equal(incomparable.code, 1);
    assert.equal(incomparable.report.samples.length, 1);
    assert.equal(incomparable.report.comparison.comparable, false);
    writeFileSync(baselinePath, "null");
    await assert.rejects(runDoctorBenchmark({ ...f, out: join(f.base,"invalid-baseline"), baselinePath }), /successful/);
  } finally { clean(f); }
});

test("Separate engine edits invalidate measurement even when Catalog bytes stay unchanged", async () => {
  const f=fixture("engine-drift");
  try {
    const engine=join(f.base,"engine");mkdirSync(engine);execFileSync("git",["init","-q",engine]);
    renameSync(join(f.repo,"scripts"),join(engine,"scripts"));
    const result=await runDoctorBenchmark({...f,engine});
    assert.equal(result.code,1);
    assert.match(result.report.issues.join(" "),/Engine source changed/);
    assert.equal(result.report.source.fingerprint===result.report.engineSource.fingerprint,false);
  } finally {clean(f);}
});

test("Benchmark keeps artifacts out of repository paths and redacts credential-shaped logs", async () => {
  const f = fixture("secret-output");
  try {
    await assert.rejects(runDoctorBenchmark({ ...f, out: join(f.repo,"artifacts") }), /outside/);
    symlinkSync(f.repo,join(f.base,"repo-alias"),"dir");
    await assert.rejects(runDoctorBenchmark({ ...f, out: join(f.base,"repo-alias/artifacts") }), /outside/);
    await assert.rejects(runDoctorBenchmark({ ...f, runs: 2 }), /--runs/);
    await assert.rejects(runDoctorBenchmark({ ...f, maxRegressionPercent: 20 }), /--baseline/);
    const result = await runDoctorBenchmark(f);
    assert.equal(result.code, 0);
    for (const sample of result.report.samples) {
      const log = readFileSync(join(f.out,sample.log),'utf8');
      assert.ok(log.includes("[credential-shaped output redacted]"));
      assert.equal(log.includes("A".repeat(40)),false);
    }
  } finally { clean(f); }
});
