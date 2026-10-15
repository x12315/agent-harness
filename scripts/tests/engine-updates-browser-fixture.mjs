#!/usr/bin/env node
import { rmSync, writeFileSync } from "node:fs";
import { startHarnessWeb } from "../web.mjs";
import { createCatalogSyncFixture } from "./web-fixture.mjs";
import { createEngineUpdatesFixture } from "./engine-updates-fixture.mjs";

const catalog = createCatalogSyncFixture();
const engine = createEngineUpdatesFixture();
const instance = await startHarnessWeb({ repo: catalog.repo, engine: engine.engine, syncHome: engine.home, models: [], piResources: {} });
engine.update();
writeFileSync(process.argv[2], JSON.stringify({ root: engine.root, engine: engine.engine, source: engine.source, home: engine.home, repo: catalog.repo, catalogRoot: catalog.root, url: instance.url, origin: instance.origin, pid: process.pid }), { mode: 0o600 });
console.log(`Engine updates fixture started at ${instance.origin}`);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { instance.server.close(); instance.server.closeAllConnections(); });
await instance.closed;
engine.restoreEnvironment(); catalog.restoreEnvironment();
rmSync(engine.root, { recursive: true, force: true }); rmSync(catalog.root, { recursive: true, force: true });
