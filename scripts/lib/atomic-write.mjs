import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

/** Atomically replace text after an optional byte CAS and write-time destination guard.
 * null expects a missing file; undefined skips byte CAS. Temporary files are private and exclusive;
 * collisions are left intact. This is one-file replacement, not a multi-file transaction.
 */
export function atomicWrite(path, content, tag = process.pid, expected, guard = () => {}) {
	const temporary = `${path}.tmp-${tag}`;
	let created = false;
	try {
		guard();
		writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
		created = true;
		guard();
		let current;
		try { current = readFileSync(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; current = null; }
		if (expected !== undefined && current !== expected) {
			throw Object.assign(new Error(`catalog source changed before atomic replacement: ${path}`), { code: "ECHANGED" });
		}
		renameSync(temporary, path);
	} catch (error) {
		if (created) { try { guard(); rmSync(temporary, { force: true }); } catch { /* Keep evidence if parents changed. */ } }
		throw error;
	}
}
