import { execFile } from "node:child_process";

/** Build an offline verification environment using native resources, not the calling Pi Profile.
 * Copies the parent environment without changing it; explicit overrides cannot restore nesting.
 */
export function verificationEnvironment(overrides = {}) {
  const env = { ...process.env, ...overrides, PI_OFFLINE: "1" };
  delete env.PI_CODING_AGENT_DIR;
  return env;
}

/** Run an offline check without blocking other independent checks.
 * Nonzero exits, spawn errors, timeouts and output overflow retain a failing status.
 */
export function runCheckCommand(command, args, options = {}) {
  const { input, env, ...execOptions } = options;
  return new Promise((resolve) => {
    const child = execFile(command, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, ...execOptions, env: verificationEnvironment(env) }, (error, stdout, stderr) => {
      resolve({ status: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr, error });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

/** Run independent checks with bounded concurrency and return results in input order.
 * Checks sharing mutable runtime state must stay in a single serial job.
 */
export async function mapChecks(values, check, concurrency = 3) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("Check concurrency must be an integer from 1 to 8");
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await check(values[index], index);
    }
  }));
  return results;
}
