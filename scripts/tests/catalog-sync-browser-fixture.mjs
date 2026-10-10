#!/usr/bin/env node
// Disposable local Git source and data-only Catalog. Never uses author settings, packages or credentials.
import { writeFileSync, rmSync } from "node:fs";
import { startHarnessWeb } from "../web.mjs";
import { createCatalogSyncFixture } from "./web-fixture.mjs";

const fixture = createCatalogSyncFixture();
const models = ["gpt-heavy", "gpt-medium", "gpt-ultralight"].map(id => ({ provider: "openai-codex", id, thinkingLevels: ["off", "medium"] }));
const instance = await startHarnessWeb({ repo: fixture.repo, syncHome: fixture.home, models, piResources: {} });
fixture.update("Remote fixture update: safe configuration only.\n");
writeFileSync(process.argv[2], JSON.stringify({ ...Object.fromEntries(Object.entries(fixture).filter(([, value]) => typeof value === "string")), origin: instance.origin, url: instance.url, pid: process.pid }), { mode: 0o600 });
console.log(`Catalog sync fixture started at ${instance.origin}`);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { instance.server.close(); instance.server.closeAllConnections(); });
await instance.closed;
rmSync(fixture.root, { recursive: true, force: true });
