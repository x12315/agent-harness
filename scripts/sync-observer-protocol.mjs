#!/usr/bin/env node
/**
 * Copy the canonical observation protocol into each installed plugin.
 *
 * Plugins are installed as self-contained directories, so they cannot import a
 * sibling Engine module after installation. The copies are generated, committed
 * and checked for byte identity instead of being fetched or duplicated by hand.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "adapters/pi/observer-protocol/index.mjs");
const targets = [
	join(root, "adapters/pi/observer-webui/protocol.generated.mjs"),
	join(root, "adapters/pi/coordinator-webui/protocol.generated.mjs"),
];

export const BANNER = "// GENERATED from adapters/pi/observer-protocol/index.mjs. Run `node scripts/sync-observer-protocol.mjs`; do not edit this copy.\n";

export async function expectedCopy() {
	return BANNER + await readFile(source, "utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const body = await expectedCopy();
	for (const target of targets) {
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, body, { mode: 0o644 });
		console.log(`synced ${target.slice(root.length + 1)}`);
	}
}
