import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

/** Node resolves this projected .mjs entry to the repository before following shared save-policy imports. */
export { planCatalogValidation } from "../../../scripts/lib/catalog-validation.mjs";
export { scanText } from "../../../scripts/secret-scan.mjs";
export { CATALOG, ENGINE } from "../../../scripts/lib/repo.mjs";

const WIDE_CHARACTER = /[\u1100-\u115f\u2329\u232a\u2e80-\u303e\u3040-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u;
const ZERO_WIDTH_CHARACTER = /[\p{Mark}\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f]/u;

function terminalColumns(character) {
	if (ZERO_WIDTH_CHARACTER.test(character)) return 0;
	return WIDE_CHARACTER.test(character) || /\p{Extended_Pictographic}/u.test(character) ? 2 : 1;
}

/** Collapse and bound a Skill description so SettingsList cannot consume the viewport. */
export function summarizeSkillDescription(description, maxColumns = 112) {
	const compact = description.replace(/\s+/g, " ").trim();
	let columns = 0;
	let summary = "";
	for (const character of compact) {
		const next = columns + terminalColumns(character);
		if (next > maxColumns - 1) return `${summary.trimEnd()}…`;
		summary += character;
		columns = next;
	}
	return summary;
}

/** Prefer the session model scope; otherwise use all models available to Pi. */
export function modelSelectionPool(scopedModels, availableModels) {
	const models = scopedModels.length > 0 ? scopedModels.map((entry) => entry.model) : availableModels;
	const unique = new Map();
	for (const model of models) unique.set(`${model.provider}\0${model.id}`, model);
	return [...unique.values()];
}

export function setInstructionSelection(selections, id, detail) {
	const index = selections.findIndex((selection) => selection.id === id);
	if (detail === undefined) {
		if (index >= 0) selections.splice(index, 1);
		return;
	}
	if (index >= 0) selections[index] = { id, detail };
	else selections.push({ id, detail });
}

export function acquireCatalogLock(source) {
	const path = `${source}.harness.lock`;
	let fd;
	try {
		fd = openSync(path, "wx", 0o600);
		writeFileSync(fd, `${process.pid}\n`);
		return { fd, path };
	} catch (error) {
		if (fd !== undefined) {
			try { closeSync(fd); } catch { /* best effort */ }
			rmSync(path, { force: true });
		}
		if (error?.code === "EEXIST") {
			const conflict = new Error(`catalog source is locked by another harness manager: ${path}`);
			conflict.code = "ELOCKED";
			throw conflict;
		}
		throw error;
	}
}

export function releaseCatalogLock(lock) {
	try { closeSync(lock.fd); }
	finally { rmSync(lock.path, { force: true }); }
}

export function atomicWrite(path, content, tag = process.pid, expected) {
	const temporary = `${path}.tmp-${tag}`;
	try {
		writeFileSync(temporary, content);
		if (expected !== undefined && readFileSync(path, "utf8") !== expected) {
			const conflict = new Error(`catalog source changed before atomic replacement: ${path}`);
			conflict.code = "ECHANGED";
			throw conflict;
		}
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}
