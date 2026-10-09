import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { hostname, cpus, availableParallelism, release, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { acquireCatalogLock, releaseCatalogLock } from "../../adapters/pi/extensions/harness-manager-state.mjs";
import { scanText } from "../secret-scan.mjs";
import { runCheckCommand } from "./check-runner.mjs";
import { ENGINE } from "./repo.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const stableJson = (value) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const equal = (a, b) => stableJson(a) === stableJson(b);
const coverage = (sample) => (Array.isArray(sample?.checks) ? sample.checks : []).map(({ name, status }) => ({ name, status })).sort((a, b) => a.name.localeCompare(b.name));

/** Summarize wall-clock samples; small runs deliberately report no tail percentile. */
export function benchmarkStatistics(values) {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value <= 0)) throw new Error("Invalid benchmark durations");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return { samples: sorted.length, minMs: sorted[0], medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, maxMs: sorted.at(-1) };
}

/** Compare only successful reports with matching hardware/runtime/workload and check coverage.
 * Repository revisions and source hashes are intentionally allowed to differ across releases.
 */
export function compareDoctorBenchmarks(current, baseline) {
  const reasons = [];
  if (baseline?.schemaVersion !== 2 || baseline?.metric !== "doctor.wall-clock" || baseline?.ok !== true || !Number.isFinite(baseline?.statistics?.parallel?.medianMs) || baseline.statistics.parallel.medianMs <= 0) reasons.push("Baseline is not a successful doctor benchmark report");
  if (!equal(current.environment, baseline?.environment)) reasons.push("Machine or runtime environment differs");
  if (!equal(current.workload, baseline?.workload)) reasons.push("Catalog workload differs");
  if (!equal(coverage(current.samples[0]), baseline?.samples?.[0] ? coverage(baseline.samples[0]) : [])) reasons.push("Verification coverage or skip status differs");
  return {
    comparable: reasons.length === 0, reasons,
    medianChangePercent: reasons.length || !current.statistics?.parallel ? null : (current.statistics.parallel.medianMs / baseline.statistics.parallel.medianMs - 1) * 100,
  };
}

function benchmarkCommand(command, args, options) {
  const env = { ...process.env, ...options?.env, PI_OFFLINE: "1" };
  delete env.PI_CODING_AGENT_DIR;
  return runCheckCommand(command, args, { ...options, env });
}

async function git(repo, args) {
  const result = await benchmarkCommand("git", ["-C", repo, ...args], { timeout: 10_000 });
  if (result.status !== 0) throw new Error(`Git benchmark metadata unavailable: ${args.join(" ")}`);
  return result.stdout;
}

async function sourceIdentity(repo) {
  const files = [...new Set((await git(repo, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0").filter(Boolean))].sort();
  const hash = createHash("sha256");
  for (const path of files) {
    const file = join(repo, path);
    hash.update(`${path}\0`);
    if (!existsSync(file)) hash.update("deleted\0");
    else if (lstatSync(file).isFile()) hash.update(sha256(readFileSync(file)));
    else hash.update("non-regular\0");
  }
  return hash.digest("hex");
}

async function context(repo, engine) {
  const version = async (command) => {
    const result = await benchmarkCommand(command, ["--version"], { timeout: 10_000 });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const head = await benchmarkCommand("git", ["-C", repo, "rev-parse", "HEAD"], { timeout: 10_000 });
  const engineHead = await benchmarkCommand("git", ["-C", engine, "rev-parse", "HEAD"], { timeout: 10_000 });
  const catalog = await benchmarkCommand(process.execPath, [join(engine, "scripts/harness.mjs"), "status", "--json"], { timeout: 30_000, env: { HARNESS_CATALOG: repo } });
  let state;
  try { state = JSON.parse(catalog.stdout); } catch { throw new Error("Cannot read Catalog benchmark workload"); }
  if (catalog.status !== 0 || !state.ok || !Array.isArray(state.profiles) || !state.skills || state.profiles.some((profile) => typeof profile.name !== "string" || !profile.name)) throw new Error("Catalog status failed or workload is incomplete");
  const composition = await benchmarkCommand(process.execPath, [join(engine, "scripts/harness.mjs"), "compose", "--json"], { timeout: 30_000, env: { HARNESS_CATALOG: repo } });
  let compiled;
  try { compiled = JSON.parse(composition.stdout); } catch { throw new Error("Cannot read instruction benchmark workload"); }
  if (composition.status !== 0 || compiled.ok !== true || !Number.isInteger(compiled.modules) || compiled.modules < 1) throw new Error("Composition check failed or instruction count is missing");
  return {
    environment: {
      machine: sha256(hostname()).slice(0, 12), platform: process.platform, arch: process.arch,
      osRelease: release(), cpu: cpus()[0]?.model ?? "unknown", parallelism: availableParallelism(), totalMemoryBytes: totalmem(),
      node: process.version, pi: await version("pi"), codex: await version("codex"), profileRuntime: state.runtimes?.piProfileSwitch ?? null,
    },
    source: { revision: head.status === 0 ? head.stdout.trim() : null, dirty: Boolean((await git(repo, ["status", "--porcelain"])).trim()), fingerprint: await sourceIdentity(repo) },
    engineSource: { root: engine, revision: engineHead.status === 0 ? engineHead.stdout.trim() : null, dirty: Boolean((await git(engine, ["status", "--porcelain"])).trim()), fingerprint: await sourceIdentity(engine) },
    workload: {
      profiles: state.profiles.map((profile) => profile.name).sort(),
      skills: state.skills, instructionEntries: compiled.modules,
      profileConfigurations: Object.fromEntries(state.profiles.map(({ name }) => {
        const { label, description, $schema, ...configuration } = JSON.parse(readFileSync(join(repo, "profiles", `${name}.json`), "utf8"));
        return [name, sha256(stableJson(configuration))];
      })),
    },
  };
}

function externalOutput(repo, out, engine) {
  const absolute = resolve(out);
  let ancestor = absolute;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const actual = resolve(realpathSync(ancestor), relative(ancestor, absolute));
  const roots = [realpathSync(repo), realpathSync(engine)];
  if (roots.some((root) => actual === root || actual.startsWith(`${root}/`))) throw new Error("Benchmark artifacts must be outside the repository");
  if (existsSync(absolute)) throw new Error("Output directory already exists; choose a new path to preserve evidence");
  return absolute;
}

function redactedLog(output) {
  const lines = output.split("\n");
  for (const hit of scanText("benchmark", output)) lines[Number(hit.where.split(":").at(-1)) - 1] = "[credential-shaped output redacted]";
  return lines.join("\n");
}

/** Run fresh full doctors, alternate serial/parallel order, retain logs and a versioned report.
 * Holds the Catalog write lock; refuses repository-local artifacts or overwriting evidence.
 * Optional budgets fail closed, as do failed doctors, source drift or incomparable baselines.
 * Does not install dependencies, modify Catalog sources, or cache verification results.
 */
export async function runDoctorBenchmark({ repo, out, engine = ENGINE, runs = 3, baselinePath, maxRegressionPercent, maxMedianMs }) {
  if (!Number.isInteger(runs) || runs < 3 || runs > 30) throw new Error("--runs must be an integer from 3 to 30");
  if (maxRegressionPercent !== undefined && (!baselinePath || !Number.isFinite(maxRegressionPercent) || maxRegressionPercent < 0)) throw new Error("A nonnegative regression budget requires --baseline");
  if (maxMedianMs !== undefined && (!Number.isFinite(maxMedianMs) || maxMedianMs <= 0)) throw new Error("Median budget must be positive");
  const output = externalOutput(repo, out, engine);
  let baseline = null;
  if (baselinePath) {
    const text = readFileSync(baselinePath, "utf8");
    try { baseline = JSON.parse(text); }
    catch { throw new Error("Baseline report is not valid JSON"); }
  }
  if (baselinePath && (baseline?.schemaVersion !== 2 || baseline?.metric !== "doctor.wall-clock" || baseline?.ok !== true || !Number.isFinite(baseline?.statistics?.parallel?.medianMs) || baseline.statistics.parallel.medianMs <= 0 || !baseline.samples?.length)) throw new Error("Baseline must be a successful schemaVersion=2 doctor benchmark report");
  let lock;
  let report;
  const save = () => writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  try {
    lock = acquireCatalogLock(join(repo, ".catalog"));
    mkdirSync(dirname(output), { recursive: true });
    mkdirSync(output, { mode: 0o700 });
    report = {
      schemaVersion: 2, metric: "doctor.wall-clock", createdAt: new Date().toISOString(), ok: false,
      method: { runsPerMode: runs, order: "alternating first mode per round", warmups: 0, freshProcesses: true, cachedPasses: false },
      ...(await context(repo, engine)), samples: [], issues: [],
    };
    save();
    let expectedCoverage;
    for (let round = 1; round <= runs; round++) {
      for (const mode of round % 2 ? ["serial", "parallel"] : ["parallel", "serial"]) {
        const started = performance.now();
        const result = await benchmarkCommand(process.execPath, [join(engine, "scripts/harness.mjs"), "doctor", "--json", ...(mode === "serial" ? ["--serial"] : [])], { cwd: repo, env: { HARNESS_CATALOG: repo }, timeout: 600_000, killSignal: "SIGKILL" });
        const durationMs = Math.round(performance.now() - started);
        const log = `${round}-${mode}.log`;
        writeFileSync(join(output, log), redactedLog(`${result.stdout}\n${result.stderr}`), { mode: 0o600, flag: "wx" });
        let verified;
        try { verified = JSON.parse(result.stdout.split("== verify\n").at(-1)); } catch { /* rejected below */ }
        const checks = Array.isArray(verified?.checks) ? verified.checks.map(({ name, status, durationMs }) => ({ name, status, durationMs })) : [];
        const sample = { round, mode, durationMs, exitCode: result.status, verifierDurationMs: verified?.durationMs ?? null, checks, log };
        report.samples.push(sample);
        console.log(`${mode} ${round}/${runs}: ${durationMs}ms, exit=${result.status}`);
        if (result.status !== 0 || verified?.ok !== true || !checks.length || checks.some((check) => !["pass", "skip"].includes(check.status))) report.issues.push(`Doctor failed or its verifier report is incomplete: ${log}`);
        expectedCoverage ??= coverage(sample);
        if (!equal(expectedCoverage, coverage(sample))) report.issues.push(`Verification coverage changed: ${log}`);
        if (await sourceIdentity(repo) !== report.source.fingerprint) report.issues.push(`Source changed during measurement: ${log}`);
        if (baseline && report.samples.length === 1) {
          report.comparison = compareDoctorBenchmarks(report, baseline);
          if (!report.comparison.comparable) report.issues.push(...report.comparison.reasons);
        }
        if (await sourceIdentity(engine) !== report.engineSource.fingerprint) report.issues.push(`Engine source changed during measurement: ${log}`);
        save();
        if (report.issues.length) return { code: 1, report, output };
      }
    }
    report.statistics = Object.fromEntries(["serial", "parallel"].map((mode) => [mode, benchmarkStatistics(report.samples.filter((sample) => sample.mode === mode).map((sample) => sample.durationMs))]));
    report.reductionPercent = (1 - report.statistics.parallel.medianMs / report.statistics.serial.medianMs) * 100;
    if (baseline) {
      report.comparison = compareDoctorBenchmarks(report, baseline);
      if (!report.comparison.comparable) report.issues.push(...report.comparison.reasons);
      else if (maxRegressionPercent !== undefined && report.comparison.medianChangePercent > maxRegressionPercent + 1e-9) report.issues.push(`Parallel median regression exceeds ${maxRegressionPercent}%`);
    }
    if (maxMedianMs !== undefined && report.statistics.parallel.medianMs > maxMedianMs) report.issues.push(`Parallel median exceeds ${maxMedianMs}ms`);
    report.ok = report.issues.length === 0;
    save();
    return { code: report.ok ? 0 : 1, report, output };
  } catch (error) {
    if (report) { report.issues.push(error.message); save(); }
    throw error;
  } finally { if (lock) releaseCatalogLock(lock); }
}
