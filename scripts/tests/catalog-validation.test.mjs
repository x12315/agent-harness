import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { planCatalogValidation } from "../lib/catalog-validation.mjs";
import { verificationOptions } from "../verify.mjs";
import { createWebFixture } from "./web-fixture.mjs";

function plan(root, path, before, after) {
	return planCatalogValidation({ repo: root, source: join(root, path), before, after });
}

test("Profile diffs select metadata, adapter, shared-resource and lifecycle checks", () => {
	const root = createWebFixture();
	try {
		const path = "profiles/medium.json";
		const before = readFileSync(join(root, path), "utf8");
		const original = JSON.parse(before);
		const change = (update) => { const value = structuredClone(original); update(value); return plan(root, path, before, JSON.stringify(value)); };
		for (const key of ["label", "description"]) {
			const result = change((value) => { value[key] = "Only metadata changed"; });
			assert.equal(result.kind, "metadata");
			assert.deepEqual(result.steps.map((step) => step.args), [["compose", "--apply"], ["verify", "--catalog"]]);
		}
		assert.deepEqual(change((value) => { value.adapters.pi.model.thinking = "high"; }).runtime, { pi: ["medium"], codex: [] });
		assert.deepEqual(change((value) => { value.adapters.codex.sandbox = "read-only"; }).runtime, { pi: [], codex: ["medium"] });
		for (const key of ["skills", "instructions"]) assert.deepEqual(change((value) => { value[key] = []; }).runtime, { pi: ["medium"], codex: ["medium"] });
		const reordered = { adapters: original.adapters, skills: original.skills, instructions: original.instructions, description: original.description, label: original.label, $schema: original.$schema };
		assert.equal(plan(root, path, before, JSON.stringify(reordered)).kind, "metadata", "object key order is not a runtime change");
		const created = plan(root, path, null, before);
		assert.equal(created.project, true);
		assert.deepEqual(created.runtime, { pi: ["medium"], codex: ["medium"] });
		const deleted = plan(root, path, before, null);
		assert.equal(deleted.project, true);
		assert.deepEqual(deleted.runtime, { pi: [], codex: [] });
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Shared instruction changes check only consumers of the changed variant", () => {
	const root = createWebFixture();
	try {
		const path = join(root, "profiles/heavy.json");
		const value = JSON.parse(readFileSync(path));
		value.instructions[0].detail = "detailed";
		writeFileSync(path, JSON.stringify(value));
		assert.deepEqual(plan(root, "instructions/profile/implementation.detailed.md", "old", "new").runtime, { pi: ["heavy"], codex: ["heavy"] });
		assert.deepEqual(plan(root, "instructions/profile/implementation.md", "old", "new").runtime, { pi: ["medium", "ultralight"], codex: ["medium", "ultralight"] });
		assert.deepEqual(plan(root, "instructions/profile/strategic.md", "old", "new").runtime, { pi: [], codex: [] });
		assert.deepEqual(plan(root, "instructions/mandatory/00-safety.brief.md", "old", "new").runtime, { pi: [], codex: [] });
		const everyone = { pi: ["heavy", "medium", "ultralight"], codex: ["heavy", "medium", "ultralight"] };
		assert.deepEqual(plan(root, "instructions/mandatory/00-safety.md", "old", "new").runtime, everyone);
		const selection = readFileSync(join(root, "instructions/selection.json"), "utf8");
		const changed = JSON.parse(selection); changed.repository = [];
		assert.deepEqual(plan(root, "instructions/selection.json", selection, JSON.stringify(changed)).runtime, everyone);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Atomic verifier options fail closed rather than broadening or silently skipping checks", () => {
	assert.deepEqual(verificationOptions([]), { catalogOnly: false });
	assert.deepEqual(verificationOptions(["--catalog"]), { catalogOnly: true });
	assert.deepEqual(verificationOptions(["--runtime=pi", "--profile=Alpha.1", "--profile=medium"]), { adapters: ["pi"], profiles: ["Alpha.1", "medium"] });
	for (const args of [["--runtime=pi"], ["--profile=medium"], ["--runtime=typo", "--profile=medium"], ["--catalog", "--profile=medium"], ["--catalogue"], ["--runtime=pi", "--profile=../escape"]]) assert.throws(() => verificationOptions(args));
});

function realVerifierFixture(root) {
	cpSync(new URL("../", import.meta.url), join(root, "scripts"), { recursive: true, filter: (path) => !path.includes("/scripts/tests") });
	cpSync(new URL("../../adapters/pi/extensions/harness-manager-state.mjs", import.meta.url), join(root, "adapters/pi/extensions/harness-manager-state.mjs"));
	cpSync(new URL("../../adapters/pi/extensions/subagent/tool-policy.mjs", import.meta.url), join(root, "adapters/pi/extensions/subagent/tool-policy.mjs"));
	mkdirSync(join(root, "bin"));
	mkdirSync(join(root, "adapters/codex"), { recursive: true });
	writeFileSync(join(root, "bin/harness"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	writeFileSync(join(root, "adapters/codex/AGENTS.md"), "Fixture Codex entry\n");
	writeFileSync(join(root, "adapters/pi/settings.json"), '{"packages":[],"skills":[]}');
	const env = { ...process.env, HOME: join(root, "native-home"), HARNESS_CATALOG: root, PATH: `${join(root, "bin")}:${process.env.PATH}` };
	delete env.PI_CODING_AGENT_DIR;
	const invoke = (args) => execFileSync(process.execPath, [join(root, "scripts/harness.mjs"), ...args], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
	invoke(["compose", "--apply"]);
	invoke(["bootstrap", "--apply"]);
	return { env, invoke };
}

test("Real targeted verifier starts only the selected adapter and named Profile", () => {
	const root = createWebFixture();
	try {
		const { invoke } = realVerifierFixture(root);
		const packageRoot = join(root, "packages/pi-profile-switch");
		mkdirSync(packageRoot, { recursive: true });
		writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ version: JSON.parse(readFileSync(join(root, "scripts/pinned-versions.json"))).piProfileSwitch }));
		const stub = `#!${process.execPath}
const fs = require('fs'), path = require('path');
const command = path.basename(process.argv[1]), args = process.argv.slice(2);
fs.appendFileSync('runtime-calls.jsonl', JSON.stringify({command,args})+'\\n');
const json = value => console.log(JSON.stringify(value));
if(command === 'npm') console.log(path.join(process.cwd(),'packages'));
else if(command === 'pi') process.exit(90);
else if(command === 'codex' && args[0] === 'debug') json({models: ['gpt-heavy','gpt-medium','gpt-ultralight'].map(slug=>({slug,supported_reasoning_levels:[{effort:'medium'}]}))});
else {
 const name = command === 'pi-profile' ? args[0] : args[1];
 const p = JSON.parse(fs.readFileSync('adapters/pi/profiles/'+name+'.json'));
 if(command === 'pi-profile') {
  const extensions = p.extensions.map(id=>({id,entry:'fixture-'+id}));
  json({command:'get_commands',data:{commands:[...p.skills.map(name=>({name:'skill:'+name,source:'skill'})),{name:'skill:profile-config',source:'skill'},{name:'harness',source:'extension',sourceInfo:{source:'inline',path:'fixture-harness-manager'}}]}});
  json({type:'extension_ui_request',method:'notify',message:JSON.stringify({activeTools:p.tools,builtinTools:p.tools,toolSources:[],resolvedExtensions:extensions,instructionPresent:true,model:{provider:p.defaultProvider,id:p.defaultModel},thinking:p.defaultThinkingLevel})});
 } else json([{content:[{text:p.instructions+' '+p.skills.map(name=>'(file: r0/'+name+'/SKILL.md)').join(' ')+' sandbox_mode\` is \`workspace-write\` \`approvals_reviewer\` is \`auto_review\`'}]}]);
}
`;
		for (const command of ["pi", "pi-profile", "codex", "npm"]) writeFileSync(join(root, "bin", command), stub, { mode: 0o755 });
		const trace = join(root, "runtime-calls.jsonl");
		const calls = () => readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		invoke(["verify", "--runtime=codex", "--profile=medium"]);
		assert.deepEqual(calls().map((entry) => entry.command), ["codex", "codex"]);
		assert.deepEqual(calls()[1].args.slice(0, 2), ["-p", "medium"]);
		writeFileSync(trace, "");
		invoke(["verify", "--runtime=pi", "--profile=heavy"]);
		assert.deepEqual(calls().map((entry) => entry.command), ["npm", "pi-profile"]);
		assert.equal(calls()[1].args[0], "heavy");
		for (const serial of [false, true]) {
			writeFileSync(trace, "");
			invoke(["verify", "--runtime=codex", "--profile=medium", "--profile=heavy", "--profile=ultralight", ...(serial ? ["--serial"] : [])]);
			assert.equal(calls().filter((entry) => entry.args[0] === "debug").length, 1, "model discovery must be shared within a run");
			assert.deepEqual(calls().filter((entry) => entry.args[0] === "-p").map((entry) => entry.args[1]).sort(), ["heavy", "medium", "ultralight"]);
			assert.ok(calls().every((entry) => entry.command === "codex"));
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Real metadata save runs no runtimes, regression tests or bootstrap and leaves unrelated outputs untouched", (t) => {
	const root = createWebFixture();
	try {
		const { env } = realVerifierFixture(root);
		for (const command of ["pi", "pi-profile", "codex", "npm"]) writeFileSync(join(root, "bin", command), `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(join(root, "unexpected-runtime"))}, ${JSON.stringify(command)}); process.exit(1);\n`, { mode: 0o755 });
		const untouched = join(root, "adapters/pi/profiles/heavy.json");
		const mtime = statSync(untouched).mtimeMs;
		const transactionUrl = new URL("../lib/catalog-transaction.mjs", import.meta.url).href;
		const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
			import { readFileSync } from 'node:fs';
			import { createHash } from 'node:crypto';
			import { applyCatalogJson } from ${JSON.stringify(transactionUrl)};
			const source = ${JSON.stringify(join(root, "profiles/medium.json"))};
			const original = readFileSync(source, 'utf8');
			const value = JSON.parse(original); value.label = 'Fast rename';
			console.log(JSON.stringify(applyCatalogJson({repo:${JSON.stringify(root)},engine:${JSON.stringify(root)},source,value,expectedHash:createHash('sha256').update(original).digest('hex')})));
		`], { env, cwd: root, encoding: "utf8", timeout: 20_000 }));
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.deepEqual(result.logs.map((entry) => entry.name), ["compose", "catalog"]);
		assert.equal(result.validation.full, false);
		assert.equal(existsSync(join(root, "unexpected-runtime")), false);
		assert.equal(statSync(untouched).mtimeMs, mtime);
		assert.ok(result.logs.every((entry) => entry.durationMs >= 0));
		t.diagnostic(`Real isolated metadata save: ${result.durationMs}ms`);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
