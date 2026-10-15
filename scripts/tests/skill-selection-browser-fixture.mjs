import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startHarnessWeb } from "../web.mjs";
import { createWebFixture, MODEL_OUTPUT } from "./web-fixture.mjs";

const root = createWebFixture();
for (const name of ["lark-doc", "lark-wiki", "lark-im"]) {
	mkdirSync(join(root, "skills", name));
	writeFileSync(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture workspace capability.\n---\n`);
}
writeFileSync(join(root, ".gitignore"), ["long-skill", "short-skill", "lark-doc", "lark-wiki", "lark-im"].map(name => `!/skills/${name}/`).join("\n"));
const instance = await startHarnessWeb({ repo: root, engine: root, modelOutput: MODEL_OUTPUT, piResources: {} });
writeFileSync(process.argv[2], JSON.stringify({ root, url: instance.url, pid: process.pid }), { mode: 0o600 });
console.log("Skill selection fixture ready");
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { instance.server.close(); instance.server.closeAllConnections(); });
await instance.closed;
rmSync(root, { recursive: true, force: true });
