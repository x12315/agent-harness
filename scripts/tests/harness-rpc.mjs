#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const EXTENSION = join(REPO, "adapters/pi/extensions/harness-manager.ts");

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeInstruction(root, layer, name, title) {
	const dir = join(root, "instructions", layer);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.brief.md`), `## ${title}\n\nBrief ${title}.\n`);
	writeFileSync(join(dir, `${name}.md`), `## ${title}\n\nStandard ${title}.\n`);
	writeFileSync(join(dir, `${name}.detailed.md`), `## ${title}\n\nDetailed ${title}.\n`);
}

function createFixture() {
	const root = mkdtempSync(join(tmpdir(), "harness-rpc-"));
	mkdirSync(join(root, "profiles"), { recursive: true });
	mkdirSync(join(root, "skills", "long-skill"), { recursive: true });
	mkdirSync(join(root, "scripts"), { recursive: true });
	mkdirSync(join(root, "tmp"), { recursive: true });
	writeInstruction(root, "mandatory", "00-safety", "Safety");
	writeInstruction(root, "repository", "00-purpose", "Purpose");
	writeInstruction(root, "profile", "implementation", "Implementation");
	writeInstruction(root, "profile", "strategic", "Strategic");
	writeFileSync(join(root, "skills/long-skill/SKILL.md"), `---\nname: long-skill\ndescription: "${"Long description ".repeat(20)}FULL-DESCRIPTION-END"\n---\n\n# Long Skill\n`);
	writeJson(join(root, "instructions/selection.json"), {
		mandatory: [{ id: "mandatory/00-safety", detail: "standard" }],
		repository: [{ id: "repository/00-purpose", detail: "standard" }],
	});
	writeJson(join(root, "profiles/medium.json"), {
		label: "Medium fixture",
		description: "RPC mutation fixture",
		instructions: [{ id: "profile/implementation", detail: "standard" }],
		skills: [],
		adapters: {
			pi: { extensions: ["harness-manager"], model: { provider: "openai-codex", id: "gpt-5.6-terra" } },
			codex: { model: { id: "gpt-5.6-terra" } },
		},
	});
	writeFileSync(join(root, "scripts/harness.mjs"), `import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";\nconst args = process.argv.slice(2).join(" ");\nappendFileSync(new URL("../calls.log", import.meta.url), args + "\\n");\nconst failOnce = new URL("../fail-once", import.meta.url);\nconst failWithConcurrent = new URL("../fail-with-concurrent", import.meta.url);\nif (args === "compose --apply" && existsSync(failOnce)) { unlinkSync(failOnce); console.error("fixture forced failure"); process.exit(1); }\nif (args === "compose --apply" && existsSync(failWithConcurrent)) {\n  unlinkSync(failWithConcurrent);\n  const source = new URL("../profiles/medium.json", import.meta.url);\n  const profile = JSON.parse(readFileSync(source, "utf8"));\n  profile.description = "Concurrent edit during validation";\n  writeFileSync(source, JSON.stringify(profile, null, 2) + "\\n");\n  console.error("fixture failure after concurrent edit");\n  process.exit(1);\n}\nconsole.log("fixture harness: OK");\n`);
	return root;
}

function chooseOption(event, prefix) {
	const option = event.options?.find((value) => value.startsWith(prefix));
	assert.ok(option, `RPC select '${event.title}' has no option starting with '${prefix}': ${event.options?.join(" | ")}`);
	return option;
}

async function runScenario({ root, name, prompt, steps, verify }) {
	const env = { ...process.env, HARNESS_CATALOG: root, HARNESS_ENGINE_ENTRY: join(root, "scripts/harness.mjs"), PI_OFFLINE: "1", TMPDIR: join(root, "tmp") };
	delete env.PI_CODING_AGENT_DIR;
	const child = spawn("pi", [
		"--no-extensions",
		"--extension", EXTENSION,
		"--no-skills",
		"--no-session",
		"--offline",
		"--mode", "rpc",
	], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
	let stdout = "";
	let stderr = "";
	let buffer = "";
	let stepIndex = 0;
	let promptSucceeded = false;
	let streamError;
	const notifications = [];
	const events = [];
	const terminate = (signal) => {
		try { process.kill(-child.pid, signal); }
		catch { child.kill(signal); }
	};
	let forceDeadline;
	const deadline = setTimeout(() => {
		terminate("SIGTERM");
		forceDeadline = setTimeout(() => terminate("SIGKILL"), 2_000);
		forceDeadline.unref();
	}, 30_000);

	const respond = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
	const handle = (event) => {
		events.push(event);
		if (event.type === "extension_ui_request" && event.method === "notify") notifications.push(event.message ?? "");
		if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(event.method)) {
			const expected = steps[stepIndex++];
			assert.ok(expected, `${name}: unexpected ${event.method} '${event.title}'`);
			assert.equal(event.method, expected.method, `${name}: wrong dialog method at step ${stepIndex}`);
			if (expected.title) assert.match(event.title ?? "", expected.title, `${name}: wrong dialog title at step ${stepIndex}`);
			if (expected.before) expected.before(event);
			if (event.method === "select") respond({ type: "extension_ui_response", id: event.id, value: chooseOption(event, expected.choose) });
			else if (event.method === "confirm") respond({ type: "extension_ui_response", id: event.id, confirmed: expected.confirmed });
			else respond({ type: "extension_ui_response", id: event.id, value: expected.value });
		}
		if (event.type === "response" && event.id === name) {
			promptSucceeded = event.success === true;
			child.stdin.end();
		}
	};

	const decoder = new StringDecoder("utf8");
	child.stdout.on("data", (chunk) => {
		const text = decoder.write(chunk);
		stdout += text;
		buffer += text;
		while (buffer.includes("\n")) {
			const index = buffer.indexOf("\n");
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (line) {
				try { handle(JSON.parse(line)); }
				catch (error) { streamError = error; terminate("SIGTERM"); }
			}
		}
	});
	child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
	respond({ id: name, type: "prompt", message: prompt });
	const code = await new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", resolve);
	});
	clearTimeout(deadline);
	if (forceDeadline) clearTimeout(forceDeadline);
	const tail = decoder.end();
	stdout += tail;
	buffer += tail;
	if (buffer.trim() && !streamError) {
		try { handle(JSON.parse(buffer.trim())); }
		catch (error) { streamError = error; }
	}
	if (streamError) throw streamError;
	assert.equal(code, 0, `${name}: pi exited ${code}\n${stderr}\n${stdout.slice(-2000)}`);
	assert.equal(stderr.trim(), "", `${name}: stderr not empty`);
	assert.equal(stepIndex, steps.length, `${name}: completed ${stepIndex}/${steps.length} dialog steps`);
	assert.equal(promptSucceeded, true, `${name}: prompt response did not succeed`);
	assert.equal(events.some((event) => event.type === "agent_start"), false, `${name}: unexpectedly started model loop`);
	verify({ notifications, events });
}

const root = createFixture();
try {
const menuActions = [];
await runScenario({
	root,
	name: "menu-shortcuts",
	prompt: "/harness",
	steps: [
		{ method: "select", title: /Harness 管理面/, choose: "帮助与快捷命令", before: event => menuActions.push(...event.options.slice(0, -1)) },
		{ method: "select", title: /Harness 管理面/, choose: "退出管理面" },
	],
	verify: ({ notifications }) => {
		const help = notifications.find(message => message.startsWith("Harness 管理面"));
		assert.ok(help?.includes("/harness 是主入口"));
		const shortcuts = [...help.matchAll(/^\/harness (\w+)(?: \[id\])?\s+(.+)$/gm)];
		assert.equal(shortcuts.length, menuActions.length, "every shortcut must have a menu action");
		for (const [, name, text] of shortcuts) {
			const label = text.split(" · ")[0];
			assert.ok(menuActions.some(option => option.startsWith(label + " — ")), `shortcut ${name} is missing from the menu`);
		}
	},
});
await runScenario({
	root,
	name: "native-pi-menu-switch",
	prompt: "/harness",
	steps: [
		{ method: "select", title: /当前：原生 Pi/, choose: "切换当前工作方案" },
		{ method: "select", title: /选择当前会话的工作方案/, choose: "Medium fixture" },
		{ method: "select", title: /Harness 管理面/, choose: "退出管理面" },
	],
	verify: ({ notifications }) => {
		assert.ok(notifications.some(message => message.includes("当前是普通 Pi 会话") && message.includes("pi-h")));
	},
});
await runScenario({
	root,
	name: "native-pi-command-switch",
	prompt: "/harness switch medium",
	steps: [],
	verify: ({ notifications }) => {
		assert.ok(notifications.some(message => message.includes("当前是普通 Pi 会话") && message.includes("pi-h")));
	},
});
await runScenario({
	root,
	name: "skill-description",
	prompt: "/harness skills",
	steps: [
		{
			method: "select",
			title: /Skills 目录/,
			choose: "long-skill",
			before: (event) => {
				const option = event.options.find((value) => value.startsWith("long-skill"));
				assert.ok(option.endsWith("…"), `skill summary was not clipped: ${option}`);
				assert.doesNotMatch(option, /FULL-DESCRIPTION-END/);
			},
		},
	],
	verify: ({ notifications }) => {
		assert.ok(notifications.some((message) => message.includes("FULL-DESCRIPTION-END")));
	},
});

await runScenario({
	root,
	name: "global-instructions",
	prompt: "/harness instructions",
	steps: [
		{ method: "select", title: /AGENTS\.md 常驻词条/, choose: "逐项管理" },
		{ method: "select", title: /mandatory 锁定/, choose: "Safety" },
		{ method: "select", title: /Safety/, choose: "启用状态" },
		{ method: "select", title: /Safety/, choose: "返回上级" },
		{ method: "select", title: /mandatory 锁定/, choose: "Purpose" },
		{ method: "select", title: /Purpose/, choose: "说明详略" },
		{ method: "select", title: /选择说明详略/, choose: "详细" },
		{ method: "select", title: /Purpose/, choose: "预览当前内容" },
		{ method: "select", title: /Purpose/, choose: "编辑当前内容" },
		{ method: "editor", title: /编辑 Purpose · 详细/, value: "## Purpose\n\nEdited detailed purpose.\n" },
		{ method: "confirm", title: /应用 instruction 源码修改/, confirmed: true },
		{ method: "select", title: /Purpose/, choose: "启用状态" },
		{ method: "select", title: /Purpose/, choose: "返回上级" },
		{ method: "select", title: /mandatory 锁定/, choose: "返回上级" },
		{ method: "select", title: /AGENTS\.md 常驻词条/, choose: "保存并应用" },
		{ method: "confirm", title: /保存 AGENTS\.md 词条选择/, confirmed: true },
	],
	verify: ({ notifications }) => {
		const selection = JSON.parse(readFileSync(join(root, "instructions/selection.json"), "utf8"));
		assert.deepEqual(selection.repository, []);
		assert.match(readFileSync(join(root, "instructions/repository/00-purpose.detailed.md"), "utf8"), /Edited detailed purpose/);
		assert.ok(notifications.some((message) => message.includes("mandatory 词条属于不可关闭")));
		assert.ok(notifications.some((message) => message.includes("repository/00-purpose@detailed")));
		assert.ok(notifications.some((message) => message.includes("已更新 instruction-selection")));
	},
});

await runScenario({
	root,
	name: "profile-instructions",
	prompt: "/harness configure medium",
	steps: [
		{ method: "select", title: /配置 Medium fixture/, choose: "Profile 词条" },
		{ method: "select", title: /Profile instruction 词条/, choose: "全局规划与复杂问题" },
		{ method: "select", title: /全局规划与复杂问题/, choose: "启用状态" },
		{ method: "select", title: /全局规划与复杂问题/, choose: "说明详略" },
		{ method: "select", title: /选择说明详略/, choose: "详细" },
		{ method: "select", title: /全局规划与复杂问题/, choose: "返回上级" },
		{ method: "select", title: /Profile instruction 词条/, choose: "返回上级" },
		{ method: "select", title: /配置 Medium fixture/, choose: "保存并应用" },
		{ method: "confirm", title: /保存并应用/, confirmed: true },
	],
	verify: ({ notifications }) => {
		const profile = JSON.parse(readFileSync(join(root, "profiles/medium.json"), "utf8"));
		assert.deepEqual(profile.instructions, [
			{ id: "profile/implementation", detail: "standard" },
			{ id: "profile/strategic", detail: "detailed" },
		]);
		assert.ok(notifications.some((message) => message.includes("已更新 medium")));
	},
});

const beforeRollback = readFileSync(join(root, "profiles/medium.json"), "utf8");
writeFileSync(join(root, "fail-once"), "fail next compose\n");
await runScenario({
	root,
	name: "profile-rollback",
	prompt: "/harness configure medium",
	steps: [
		{ method: "select", title: /配置 Medium fixture/, choose: "Profile 词条" },
		{ method: "select", title: /Profile instruction 词条/, choose: "实施模式" },
		{ method: "select", title: /实施模式/, choose: "说明详略" },
		{ method: "select", title: /选择说明详略/, choose: "精简" },
		{ method: "select", title: /实施模式/, choose: "返回上级" },
		{ method: "select", title: /Profile instruction 词条/, choose: "返回上级" },
		{ method: "select", title: /配置 Medium fixture/, choose: "保存并应用" },
		{ method: "confirm", title: /保存并应用/, confirmed: true },
	],
	verify: ({ notifications }) => {
		assert.equal(readFileSync(join(root, "profiles/medium.json"), "utf8"), beforeRollback);
		assert.ok(notifications.some((message) => message.includes("已安全恢复")));
	},
});

const concurrentProfile = JSON.parse(readFileSync(join(root, "profiles/medium.json"), "utf8"));
concurrentProfile.description = "External edit must survive";
const concurrentText = `${JSON.stringify(concurrentProfile, null, 2)}\n`;
await runScenario({
	root,
	name: "profile-concurrent-edit",
	prompt: "/harness configure medium",
	steps: [
		{ method: "select", title: /配置 Medium fixture/, choose: "Profile 词条" },
		{ method: "select", title: /Profile instruction 词条/, choose: "实施模式" },
		{ method: "select", title: /实施模式/, choose: "说明详略" },
		{ method: "select", title: /选择说明详略/, choose: "详细" },
		{ method: "select", title: /实施模式/, choose: "返回上级" },
		{ method: "select", title: /Profile instruction 词条/, choose: "返回上级" },
		{ method: "select", title: /配置 Medium fixture/, choose: "保存并应用" },
		{ method: "confirm", title: /保存并应用/, confirmed: true, before: () => writeFileSync(join(root, "profiles/medium.json"), concurrentText) },
	],
	verify: ({ notifications }) => {
		assert.equal(readFileSync(join(root, "profiles/medium.json"), "utf8"), concurrentText);
		assert.ok(notifications.some((message) => message.includes("在配置期间被其他会话修改")));
		assert.ok(notifications.some((message) => message.includes("未写入任何内容")));
	},
});

writeFileSync(join(root, "fail-with-concurrent"), "fail after external validation edit\n");
await runScenario({
	root,
	name: "rollback-concurrent-edit",
	prompt: "/harness configure medium",
	steps: [
		{ method: "select", title: /配置 Medium fixture/, choose: "Profile 词条" },
		{ method: "select", title: /Profile instruction 词条/, choose: "实施模式" },
		{ method: "select", title: /实施模式/, choose: "说明详略" },
		{ method: "select", title: /选择说明详略/, choose: "详细" },
		{ method: "select", title: /实施模式/, choose: "返回上级" },
		{ method: "select", title: /Profile instruction 词条/, choose: "返回上级" },
		{ method: "select", title: /配置 Medium fixture/, choose: "保存并应用" },
		{ method: "confirm", title: /保存并应用/, confirmed: true },
	],
	verify: ({ notifications }) => {
		const profile = JSON.parse(readFileSync(join(root, "profiles/medium.json"), "utf8"));
		assert.equal(profile.description, "Concurrent edit during validation");
		assert.equal(profile.instructions.find((entry) => entry.id === "profile/implementation")?.detail, "detailed");
		assert.ok(notifications.some((message) => message.includes("恢复未完整确认")));
		assert.ok(notifications.some((message) => message.includes("自动回滚停止")));
		assert.ok(notifications.some((message) => message.includes("未覆盖其内容")));
	},
});

const calls = readFileSync(join(root, "calls.log"), "utf8").trim().split("\n");
assert.ok(calls.filter((line) => line === "compose --apply").length >= 3);
assert.ok(!calls.includes("bootstrap --apply"), "existing Profile edits need no projection rewrites");
assert.ok(calls.filter((line) => line === "verify --catalog").length >= 3);
assert.ok(calls.some((line) => line === "verify --runtime=pi --profile=medium"));
assert.ok(!calls.includes("doctor"), "ordinary TUI saves must not run the full release suite");
console.log("harness RPC loop: OK (temporary fixture removed)");
} finally {
	rmSync(root, { recursive: true, force: true });
}
