#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ENGINE as REPO } from "./lib/repo.mjs";
import { mapChecks, runCheckCommand } from "./lib/check-runner.mjs";

const noTui = process.argv.includes("--no-tui");
const tests = [
	{
		name: "catalog state",
		command: process.execPath,
		args: ["--test", join(REPO, "scripts/tests/catalog.test.mjs"), join(REPO, "scripts/tests/check-runner.test.mjs"), join(REPO, "scripts/tests/benchmark-metrics.test.mjs"), join(REPO, "scripts/tests/catalog-contract.test.mjs"), join(REPO, "scripts/tests/pi-launcher.test.mjs")],
	},
	{
		name: "Web HTTP + transactions",
		command: process.execPath,
		args: ["--test", join(REPO, "scripts/tests/catalog-validation.test.mjs"), join(REPO, "scripts/tests/web-catalog.test.mjs"), join(REPO, "scripts/tests/web-http.test.mjs")],
	},
	{
		name: "Web browser syntax",
		command: process.execPath,
		args: ["--check", join(REPO, "web/app.js")],
	},
	{
		name: "Pi launcher RPC",
		command: process.execPath,
		args: [join(REPO, "scripts/tests/pi-launcher-rpc.mjs")],
	},
	{
		name: "RPC interaction",
		command: process.execPath,
		args: [join(REPO, "scripts/tests/harness-rpc.mjs")],
	},
];
if (!noTui) {
	const expect = spawnSync("sh", ["-c", "command -v expect"], { encoding: "utf8" }).stdout.trim();
	if (expect) {
		tests.push({
			name: "real TUI smoke",
			command: expect,
			args: [join(REPO, "scripts/tests/harness-tui.exp")],
		});
	} else {
		console.log("skip  real TUI smoke (expect is not installed)");
	}
}

const results = await mapChecks(tests, async (test) => {
	const started = performance.now();
	const result = await runCheckCommand(test.command, test.args, { timeout: 60_000, killSignal: "SIGKILL" });
	return { result, elapsed: ((performance.now() - started) / 1000).toFixed(1) };
}, process.argv.includes("--serial") ? 1 : 3);
let failed = false;
for (const [index, test] of tests.entries()) {
	const { result, elapsed } = results[index];
	if (result.status === 0 && !result.error) {
		console.log(`ok    ${test.name.padEnd(18)} ${elapsed}s`);
		const summary = (result.stdout ?? "").trim().split("\n").filter(Boolean).at(-1);
		if (summary) console.log(`      ${summary}`);
	} else {
		failed = true;
		console.error(`FAIL  ${test.name.padEnd(18)} ${elapsed}s`);
		if (result.error) console.error(`      ${result.error.message}`);
		for (const line of [result.stdout, result.stderr].filter(Boolean).join("\n").trim().split("\n").slice(-30)) {
			console.error(`      ${line}`);
		}
	}
}

if (failed) {
	console.error("control-plane loop: FAILED");
	process.exitCode = 1;
} else {
	console.log(`control-plane loop: OK (${tests.length} layers)`);
}
