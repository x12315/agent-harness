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
	writeFileSync(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Synthetic ${name} browser fixture; use only for UI tests.\n---\n\n# Synthetic ${name}\n`);
}
writeFileSync(join(root, ".gitignore"), skills.map((name) => `!/skills/${name}/`).join("\n"));
const models = ["gpt-heavy", "gpt-medium", "gpt-ultralight", "gpt-6.1-sol"].map((id) => ({
	provider: "openai-codex", id, thinkingLevels: ["off", "low", "medium", "high"],
}));
const instance = await startHarnessWeb({ repo: root, engine: root, models });
const statePath = process.argv[2];
if (statePath) writeFileSync(statePath, JSON.stringify({ root, origin: instance.origin, url: instance.url, pid: process.pid }), { mode: 0o600 });
console.log(`Isolated browser fixture started at ${instance.origin}`);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => instance.server.close());
await instance.closed;
rmSync(root, { recursive: true, force: true });
