#!/usr/bin/env node
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "./lib/repo.mjs";
import { runDoctorBenchmark } from "./lib/doctor-benchmark.mjs";

/** Parse explicit benchmark budgets. No machine-dependent time budget is silently imposed. */
export function benchmarkOptions(args) {
  const options = { runs: 3, out: join(tmpdir(), `harness-benchmark-${Date.now()}-${process.pid}`) };
  const keys = { runs: "runs", out: "out", baseline: "baselinePath", "max-regression-percent": "maxRegressionPercent", "max-median-ms": "maxMedianMs" };
  const seen = new Set();
  for (const arg of args) {
    const match = arg.match(/^--([a-z-]+)=(.+)$/);
    if (!match || !keys[match[1]] || seen.has(match[1])) throw new Error(`Unknown, duplicate or empty benchmark option: ${arg}`);
    seen.add(match[1]);
    options[keys[match[1]]] = ["runs", "max-regression-percent", "max-median-ms"].includes(match[1]) ? Number(match[2]) : match[2];
  }
  return options;
}

/** CLI entry for the fresh full-doctor performance contract; exit 1 means failed measurement/budget. */
export async function run(args = process.argv.slice(2)) {
  try {
    const { code, report, output } = await runDoctorBenchmark({ repo: REPO, ...benchmarkOptions(args) });
    if (report.statistics) console.log(`Median: serial=${report.statistics.serial.medianMs}ms, parallel=${report.statistics.parallel.medianMs}ms; reduction=${report.reductionPercent.toFixed(1)}%`);
    if (report.comparison?.comparable && report.comparison.medianChangePercent !== null) console.log(`Baseline median change: ${report.comparison.medianChangePercent.toFixed(1)}%`);
    for (const issue of report.issues) console.error(`FAIL: ${issue}`);
    console.log(`${report.ok ? "PASS" : "FAIL"}: ${join(output, "report.json")}`);
    return code;
  } catch (error) { console.error(`benchmark: ${error.message}`); return 2; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await run();
