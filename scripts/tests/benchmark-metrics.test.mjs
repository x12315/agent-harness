import assert from "node:assert/strict";
import test from "node:test";
import { benchmarkOptions } from "../benchmark-doctor.mjs";
import { benchmarkStatistics, compareDoctorBenchmarks } from "../lib/doctor-benchmark.mjs";

test("Benchmark statistics and options use explicit budgets and no invented P95", () => {
  assert.deepEqual(benchmarkStatistics([30, 10, 20]), { samples: 3, minMs: 10, medianMs: 20, maxMs: 30 });
  assert.equal(benchmarkStatistics([10, 20, 30, 40]).medianMs, 25);
  assert.throws(() => benchmarkStatistics([]));
  const parsed = benchmarkOptions(["--runs=5", "--out=/tmp/test", "--baseline=/tmp/baseline.json", "--max-regression-percent=20", "--max-median-ms=8000"]);
  assert.equal(parsed.runs, 5);
  assert.equal(parsed.maxRegressionPercent, 20);
  assert.equal(benchmarkOptions([]).maxMedianMs, undefined);
  for (const args of [["--runs=3", "--runs=5"], ["--out="], ["--unknown=1"]]) assert.throws(() => benchmarkOptions(args));
});

test("Cross-release comparison rejects machine/workload/coverage changes but permits source revisions", () => {
  const report = {
    schemaVersion: 2, metric: "doctor.wall-clock", ok: true, environment: { machine: "fixture", node: "fixture" },
    workload: { profiles: ["sample"] }, source: { revision: "before" },
    statistics: { parallel: { medianMs: 100 } }, samples: [{ checks: [{ name: "runtime", status: "pass" }] }],
  };
  const current = structuredClone(report); current.source.revision = "after"; current.statistics.parallel.medianMs = 120;
  assert.equal(compareDoctorBenchmarks(current, report).comparable, true);
  assert.ok(Math.abs(compareDoctorBenchmarks(current, report).medianChangePercent - 20) < 0.001);
  for (const mutate of [r=>{r.environment.node='new';}, r=>{r.workload.profiles=[];}, r=>{r.samples[0].checks[0].status='skip';}, r=>{r.ok=false;}]) {
    const changed=structuredClone(report); mutate(changed);
    assert.equal(compareDoctorBenchmarks(current, changed).comparable, false);
  }
  assert.equal(compareDoctorBenchmarks(current, null).comparable, false);
});
