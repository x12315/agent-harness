#!/usr/bin/env node
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startHarnessWeb } from "../web.mjs";
import { createWebFixture } from "./web-fixture.mjs";

const root = createWebFixture();
for (const detail of ["", ".brief", ".detailed"]) writeFileSync(join(root, `instructions/profile/model-standard${detail}.md`), `## Fixture model policy\n\nStandalone browser fixture ${detail || "standard"}.\n`);
for (const name of ["heavy", "medium", "ultralight"]) {
	const path = join(root, "profiles", `${name}.json`);
	const profile = JSON.parse(readFileSync(path, "utf8"));
	profile.instructions.push({ id: "profile/model-standard", detail: "standard" });
	profile.skills = name === "ultralight" ? [] : ["*"];
	writeFileSync(path, JSON.stringify(profile, null, 2));
}
const skills = ["long-skill", "short-skill", "lark-base", "lark-doc", "find-skills", "git-commit"];
for (const name of skills.slice(2)) {
	mkdirSync(join(root, "skills", name), { recursive: true });
	const description = name === "lark-base" ? `${"Synthetic long browser fixture description. ".repeat(20)}FULL-SKILL-DESCRIPTION-END` : `Synthetic ${name} browser fixture; use only for UI tests.`;
	writeFileSync(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# Synthetic ${name}\n`);
}
writeFileSync(join(root, ".gitignore"), skills.map((name) => `!/skills/${name}/`).join("\n"));
const models = ["gpt-heavy", "gpt-medium", "gpt-ultralight", "gpt-6.1-sol"].map((id) => ({
	provider: "openai-codex", id, thinkingLevels: ["off", "low", "medium", "high"],
}));
const packagePath = join(root, "packages/fast");
mkdirSync(packagePath, { recursive: true });
writeFileSync(join(packagePath, "package.json"), JSON.stringify({ name: "@calesennett/pi-codex-fast", version: "0.0.0-fixture", description: "Synthetic Fast service tier extension; use only for UI tests.", pi: { extensions: ["index.ts"] } }));
writeFileSync(join(packagePath, "index.ts"), "// Metadata only; never imported.\n");
writeFileSync(join(root, "adapters/pi/extensions/harness-manager.ts"), "// Metadata only; never imported.\n");
const source = "npm:@calesennett/pi-codex-fast@0.0.0-fixture";
const piResources = {
	packages: [{ source, path: packagePath }],
	commands: [{ name: "codex-fast", description: "Toggle Fast mode", source: "extension", sourceInfo: { path: join(packagePath, "index.ts"), source, origin: "package", scope: "user" } }],
	tools: [{ name: "subagent", description: `${"Synthetic child tool description. ".repeat(20)}FULL-TOOL-DESCRIPTION-END <img src=x onerror=alert(1)>`, parameters: { type: "object", required: ["task"], properties: { task: { type: "string", description: "Task for the child agent", default: "PRIVATE-TOOL-DEFAULT" } } }, sourceInfo: { path: join(root, "adapters/pi/extensions/subagent/index.ts"), source: "auto", origin: "top-level", scope: "user" } }],
};
const instance = await startHarnessWeb({ repo: root, engine: root, models, piResources });
const statePath = process.argv[2];
if (statePath) writeFileSync(statePath, JSON.stringify({ root, origin: instance.origin, url: instance.url, pid: process.pid }), { mode: 0o600 });
console.log(`Isolated browser fixture started at ${instance.origin}`);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => instance.server.close());
await instance.closed;
rmSync(root, { recursive: true, force: true });
