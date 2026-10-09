import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeInstruction(root, layer, name, title) {
	const directory = join(root, "instructions", layer);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, `${name}.brief.md`), `## ${title}\n\nBrief ${title}.\n`);
	writeFileSync(join(directory, `${name}.md`), `## ${title}\n\nStandard ${title}.\n`);
	writeFileSync(join(directory, `${name}.detailed.md`), `## ${title}\n\nDetailed ${title}.\n`);
}

function profile(label, description, model, skills) {
	return {
		$schema: "./profile.schema.json",
		label,
		description,
		instructions: [{ id: "profile/implementation", detail: "standard" }],
		skills,
		adapters: {
			pi: {
				tools: ["read", "bash", "edit"],
				extensions: ["harness-manager"],
				mcps: [],
				model: { provider: "openai-codex", id: model, thinking: "medium" },
			},
			codex: {
				sandbox: "workspace-write",
				approval: "on-request",
				model: { id: model, thinking: "medium" },
			},
		},
	};
}

export function createWebFixture() {
	const root = mkdtempSync(join(tmpdir(), "harness-web-"));
	writeJson(join(root, "harness.catalog.json"), { schemaVersion: 1 });
	writeJson(join(root, "expected-gaps.json"), { declaredNotInstalled: {}, installedNotDeclared: {} });
	mkdirSync(join(root, "schemas"));
	copyFileSync(new URL("../../schemas/profile.schema.json", import.meta.url), join(root, "schemas/profile.schema.json"));
	for (const directory of ["profiles", "skills/long-skill", "skills/short-skill", "scripts", "tmp", "adapters/pi/extensions/subagent"]) mkdirSync(join(root, directory), { recursive: true });
	writeFileSync(join(root, "adapters/pi/extensions/bookmark.ts"), "// Fixture metadata only.\n");
	writeFileSync(join(root, "adapters/pi/extensions/subagent/index.ts"), "// Fixture metadata only.\n");
	writeInstruction(root, "mandatory", "00-safety", "Safety");
	writeInstruction(root, "repository", "00-purpose", "Purpose");
	writeInstruction(root, "profile", "implementation", "Implementation");
	writeInstruction(root, "profile", "strategic", "Strategic");
	writeJson(join(root, "instructions/selection.json"), {
		mandatory: [{ id: "mandatory/00-safety", detail: "standard" }],
		repository: [{ id: "repository/00-purpose", detail: "standard" }],
	});
	writeJson(join(root, "profiles/heavy.json"), profile("Heavy fixture", "High throughput coding", "gpt-heavy", ["long-skill"]));
	writeJson(join(root, "profiles/medium.json"), profile("Medium fixture", "Balanced daily work", "gpt-medium", ["short-skill"]));
	writeJson(join(root, "profiles/ultralight.json"), profile("Ultralight fixture", "Strategic work", "gpt-ultralight", []));
	writeFileSync(join(root, "skills/long-skill/SKILL.md"), `---\nname: long-skill\ndescription: >-\n  ${"Long skill description for narrow layouts. ".repeat(24)}\n---\n\n# Long Skill\n`);
	writeFileSync(join(root, "skills/short-skill/SKILL.md"), "---\nname: short-skill\ndescription: Short fixture skill.\n---\n\n# Short Skill\n");
	mkdirSync(join(root, "scripts/lib"), { recursive: true });
	copyFileSync(new URL("../compose.mjs", import.meta.url), join(root, "scripts/compose.mjs"));
	copyFileSync(new URL("../lib/repo.mjs", import.meta.url), join(root, "scripts/lib/repo.mjs"));
	writeJson(join(root, ".skill-lock.json"), { skills: {} });
	writeFileSync(join(root, ".gitignore"), "!/skills/long-skill/\n!/skills/short-skill/\n");
	writeFileSync(join(root, "scripts/harness.mjs"), `import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const command = process.argv.slice(2).join(" ");
appendFileSync(new URL("../calls.log", import.meta.url), command + "\\n");
const failOnce = new URL("../fail-once", import.meta.url);
if (existsSync(failOnce) && readFileSync(failOnce, "utf8") === command) {
	unlinkSync(failOnce); console.error("forced single failure"); process.exit(1);
}
if (command === "compose --apply") {
	const externalWrite = new URL("../write-on-compose", import.meta.url);
	if (existsSync(externalWrite)) {
		const { name, value } = JSON.parse(readFileSync(externalWrite, "utf8"));
		unlinkSync(externalWrite);
		writeFileSync(new URL("../profiles/" + name + ".json", import.meta.url), JSON.stringify(value));
	}
	if (existsSync(new URL("../slow-compose", import.meta.url))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
	if (existsSync(new URL("../change-on-compose", import.meta.url))) {
		const path = new URL("../profiles/medium.json", import.meta.url);
		const value = JSON.parse(readFileSync(path, "utf8"));
		value.label = "external writer";
		writeFileSync(path, JSON.stringify(value));
	}
	if (existsSync(new URL("../fail-compose", import.meta.url))) { console.error("forced compose failure"); process.exit(1); }
	const result = spawnSync(process.execPath, [new URL("compose.mjs", import.meta.url).pathname, "--apply"], { encoding: "utf8" });
	process.stdout.write(result.stdout || ""); process.stderr.write(result.stderr || "");
	if (result.status !== 0) process.exit(result.status || 1);
}
console.log("fixture " + command + ": OK");
`);
	return root;
}

/** Isolated data for real TUI probes; no user's Catalog or authentication is copied. */
export function createTuiFixture() {
	const root = createWebFixture();
	for (const suffix of ["", ".brief", ".detailed"]) writeFileSync(join(root, `instructions/mandatory/00-safety${suffix}.md`), "## 不可关闭的安全边界\n\nFixture safety.\n");
	mkdirSync(join(root, "skills/agent-browser"));
	writeFileSync(join(root, "skills/agent-browser/SKILL.md"), `---\nname: agent-browser\ndescription: ${"Long synthetic TUI description. ".repeat(20)}\n---\n\n# TUI fixture\n`);
	return root;
}

export const MODEL_OUTPUT = `provider      model       context  max-out  thinking  images\nopenai-codex  gpt-heavy   128K     64K      yes       no\nopenai-codex  gpt-medium  272K     128K     yes       yes\ndeepseek      deepseek-x   1M       128K     no        no\n`;
