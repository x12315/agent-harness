import { isDeepStrictEqual } from "node:util";

const fail = () => { throw new Error("Catalog summary metadata or installation source is invalid or unsafe."); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !value.includes("..");
const operation = (before, after) => before === null ? "add" : after === null ? "remove" : "update";
const secret = /(?:\b(?:gh[pous]_|github_pat_|hf_|sk-(?:ant-)?|xox[baprs]-|tvly-|xai-|AKIA|AIza)[A-Za-z0-9_-]{16,}|PRIVATE KEY|(?:password|token|api[_-]?key|secret)\s*[=:])/i;
const skillFields = ["sourceType", "source", "sourceUrl", "skillPath", "ref", "skillFolderHash", "wellKnownDigest", "sourceBaseUrl"];

function source(value) {
	if (typeof value !== "string" || !value || /[\x00-\x1f\x7f`]/.test(value)) fail();
	let decoded = value;
	try { for (let i = 0; i < 2; i++) decoded = decodeURIComponent(decoded); } catch { fail(); }
	if (secret.test(decoded) || /[\x00-\x1f\x7f`]/.test(decoded) || /[^/@:\s]+:[^/@\s]+@/.test(decoded.replace(/^(?:npm|git):/, ""))) fail();
	const url = decoded.match(/[a-z][a-z0-9+.-]*:\/\/\S+/i)?.[0];
	if (url) {
		try { const parsed = new URL(url); if (parsed.username || parsed.password || parsed.search || parsed.hash) fail(); }
		catch { fail(); }
	}
	return value;
}

function packageIdentity(spec) {
	const value = source(typeof spec === "string" ? spec : object(spec) ? spec.source : null);
	let name = value;
	if (value.startsWith("npm:")) {
		const match = value.match(/^npm:((?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+)(?:@([^\s]+))?$/);
		if (!match || match[1].replace(/^@/, "").split("/").some(part => !identifier(part))) fail();
		name = match[1];
	} else if (/^(?:git:|https?:\/\/)/.test(value)) {
		if (!/^(?:git:)?https?:\/\/[^\s]+$|^git:(?:github\.com\/)?[A-Za-z0-9._-]+\/[A-Za-z0-9._/@-]+$/.test(value)) fail();
		name = value.replace(/@[^@]+$/, "");
	} else if (!/^(?:\/|~\/|\.\/|\{\{HOME\}\}\/)/.test(value) || value.split(/[\\/]/).includes("..")) fail();
	return { name, source: value };
}

/** Summarize declared Catalog changes between two fixed Git trees, without I/O or execution.
 * Readers synchronously return UTF-8 text or null; files is the changed relative path list.
 * Returns entries {kind,name,label,operation,detail:{before,after}|{variants}|{count}},
 * installationChanges {kind,name,operation,source,previousSource,version} (sources are strings
 * or null; version describes the declared spec/ref/digest, never an installed version),
 * counts {total,add,update,remove,documentation}, and requiresInstallation for declaration changes.
 * Package entry details retain the full string/object spec including resource filters.
 * Throws a sanitized Error on malformed metadata, unsafe identifiers or credential-shaped sources.
 * Generated outputs are ignored. Resource lifecycle uses canonical roots and supplied changed paths.
 */
export function summarizeCatalogChanges({ readBefore, readAfter, files }) {
	if (typeof readBefore !== "function" || typeof readAfter !== "function" || !Array.isArray(files)) fail();
	const paths = [...new Set(files)].sort(), entries = [], installationChanges = [], groups = new Map();
	const read = (reader, path) => {
		let text; try { text = reader(path); } catch { fail(); }
		if (text !== null && typeof text !== "string") fail();
		return text;
	};
	const json = (reader, path) => {
		const text = read(reader, path); if (text === null) return null;
		try { const value = JSON.parse(text); if (!object(value) || secret.test(text) || /"(?:api[_-]?key|secret|token|password|passphrase)"\s*:\s*"[^"]+"/i.test(text)) fail(); return value; } catch { fail(); }
	};
	const pair = path => [json(readBefore, path), json(readAfter, path)];
	const add = (kind, name, before, after, label = name, detail = { before, after }) => {
		if (!isDeepStrictEqual(before, after)) entries.push({ kind, name, label, operation: operation(before, after), detail });
	};
	const install = (kind, name, before, after, version) => installationChanges.push({ kind, name, operation: operation(before, after), source: after, previousSource: before, version });
	let documentation = 0;
	for (const path of paths) {
		if (typeof path !== "string" || path.startsWith("/") || /[\\\x00-\x1f\x7f]/.test(path) || path.split("/").some(part => !part || part === "." || part === ".." || part === ".git")) fail();
		if (path === "AGENTS.md" || path === "profiles/profile.schema.json" || /^adapters\/[^/]+\/profiles\//.test(path)) continue;
		let match;
		if ((match = path.match(/^profiles\/([^/]+)\.json$/))) {
			const name = match[1]; if (!identifier(name)) fail();
			const values = pair(path).map(value => {
				if (value === null) return null;
				if (typeof value.label !== "string" || !value.label.trim() || !Array.isArray(value.skills) || !Array.isArray(value.instructions) || !object(value.adapters)) fail();
				validateSelections(value.instructions, "profile");
				if (value.skills.some(skill => typeof skill !== "string" || /[\x00-\x1f\x7f]|\.\./.test(skill))) fail();
				for (const adapter of Object.values(value.adapters)) {
					if (!object(adapter) || (adapter.model !== undefined && (!object(adapter.model) || typeof adapter.model.id !== "string"))) fail();
					for (const key of ["tools", "extensions", "mcps"]) if (adapter[key] !== undefined && (!Array.isArray(adapter[key]) || adapter[key].some(name => typeof name !== "string" || /[\x00-\x1f\x7f]|\.\./.test(name)))) fail();
				}
				const { $schema, ...config } = value; return config;
			});
			add("profile", name, ...values, (values[1] ?? values[0])?.label);
		} else if (path === ".skill-lock.json") {
			const locks = pair(path).map(value => {
				if (value === null) return {};
				if (!object(value.skills)) fail();
				return Object.fromEntries(Object.entries(value.skills).map(([name, spec]) => {
					if (!identifier(name) || !object(spec) || typeof spec.sourceType !== "string" || !["source", "sourceUrl", "sourceBaseUrl"].some(key => spec[key])) fail();
					if (spec.skillPath !== undefined && (typeof spec.skillPath !== "string" || spec.skillPath.split(/[\\/]/).includes(".."))) fail();
					const identity = Object.fromEntries(skillFields.filter(key => spec[key] !== undefined).map(key => [key, source(spec[key])]));
					return [name, identity];
				}));
			});
			for (const name of [...new Set(locks.flatMap(lock => Object.keys(lock)))].sort()) {
				const before = Object.hasOwn(locks[0], name) ? locks[0][name] : null, after = Object.hasOwn(locks[1], name) ? locks[1][name] : null;
				if (isDeepStrictEqual(before, after)) continue;
				add("skill", name, before, after);
				const origin = value => value ? value.source ?? value.sourceBaseUrl ?? value.sourceUrl : null;
				const spec = after ?? before;
				install("skill", name, origin(before), origin(after), [spec.ref, spec.skillFolderHash, spec.wellKnownDigest].filter(Boolean).join(" · ") || "Declared source; version unspecified");
			}
		} else if (path === "adapters/pi/settings.json") {
			const settings = pair(path), packages = settings.map(value => {
				if (value?.packages !== undefined && !Array.isArray(value.packages)) fail();
				const result = new Map();
				for (const spec of value?.packages ?? []) {
					const { name } = packageIdentity(spec); if (result.has(name)) fail();
					if (object(spec) && Object.entries(spec).some(([key, filters]) => key !== "source" && (!Array.isArray(filters) || filters.some(filter => typeof filter !== "string")))) fail();
					result.set(name, spec);
				} return result;
			});
			for (const name of [...new Set(packages.flatMap(map => [...map.keys()]))].sort()) {
				const before = packages[0].get(name) ?? null, after = packages[1].get(name) ?? null;
				add("pi-package", name, before, after);
				const origin = value => value === null ? null : packageIdentity(value).source;
				if (origin(before) !== origin(after)) install("pi-package", name, origin(before), origin(after), origin(after) ?? origin(before));
			}
			const rest = value => {
				const config = Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => key !== "packages"));
				return Object.keys(config).length ? config : null;
			};
			add("settings", "pi", rest(settings[0]), rest(settings[1]), "Pi engineering settings");
		} else if (path === "instructions/selection.json") {
			const values = pair(path);
			for (const value of values) if (value !== null) for (const [scope, selections] of Object.entries(value)) validateSelections(selections, scope);
			add("instruction-selection", "global", ...values, "Global instruction selection");
		} else if ((match = path.match(/^instructions\/(mandatory|repository|profile)\/([^/]+?)(?:\.(brief|detailed))?\.md$/))) {
			const [, scope, name] = match; if (!identifier(name)) fail();
			groups.set(`instruction:${scope}/${name}`, { kind: "instruction", name: `${scope}/${name}`, paths: ["brief", "standard", "detailed"].map(variant => `instructions/${scope}/${name}${variant === "standard" ? "" : `.${variant}`}.md`) });
		} else if ((match = path.match(/^(?:skills\/([^/]+)\/|adapters\/pi\/(extensions|agents|prompts)\/([^/]+))(.*)$/))) {
			const name = match[1] ?? match[3].replace(/\.(?:[cm]?[jt]s|md)$/, ""); if (!identifier(name)) fail();
			const kind = match[1] ? "own-skill" : `pi-${{ extensions: "extension", agents: "agent", prompts: "prompt" }[match[2]]}`;
			const key = `${kind}:${name}`, group = groups.get(key) ?? { kind, name, paths: [] };
			group.paths.push(path); groups.set(key, group);
		} else if ([".gitignore", "expected-gaps.json", "harness.catalog.json"].includes(path)) {
			const values = path.endsWith(".json") ? pair(path) : [read(readBefore, path), read(readAfter, path)].map(text => text === null ? null : text.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#")));
			add("settings", path === ".gitignore" ? "resource-exclusions" : path.replace(/\.json$/, ""), ...values);
		} else if (/^adapters\/[^/]+\/.*\.json$/.test(path)) add("settings", path.replace(/\.json$/, ""), ...pair(path));
		else if (/\.(?:md|txt)$/.test(path) || path === "LICENSE") documentation++;
	}
	for (const group of groups.values()) {
		const root = group.kind === "own-skill" ? `skills/${group.name}/SKILL.md` : group.kind === "pi-extension" ? `adapters/pi/extensions/${group.name}/index.ts` : null;
		const paths = [...new Set([...group.paths, ...(root ? [root] : [])])];
		const values = [readBefore, readAfter].map(reader => paths.map(path => read(reader, path)));
		const presence = values.map(texts => texts.some(text => text !== null) ? true : null);
		if (isDeepStrictEqual(...values)) continue;
		const variants = group.kind === "instruction" ? ["brief", "standard", "detailed"].filter((_, i) => values[0][i] !== values[1][i]) : null;
		const heading = group.kind === "instruction" ? [...values[1], ...values[0]].find(text => text?.match(/^#{1,6}\s+(.+)$/m))?.match(/^#{1,6}\s+(.+)$/m)?.[1] : null;
		entries.push({ kind: group.kind, name: group.name, label: heading?.slice(0, 120) ?? group.name, operation: operation(...presence), detail: variants ? { variants } : { count: group.paths.length } });
	}
	if (documentation) entries.push({ kind: "documentation", name: "documentation", label: "Documentation", operation: "update", detail: { count: documentation } });
	entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
	const counts = { total: entries.length, add: 0, update: 0, remove: 0, documentation };
	for (const entry of entries) counts[entry.operation]++;
	return { entries, installationChanges, counts, requiresInstallation: installationChanges.length > 0 };
}

function validateSelections(selections, scope) {
	if (!["mandatory", "repository", "profile"].includes(scope) || !Array.isArray(selections)) fail();
	for (const selection of selections) if (!object(selection) || typeof selection.id !== "string" || !selection.id.startsWith(`${scope}/`) || !identifier(selection.id.slice(scope.length + 1)) || !["brief", "standard", "detailed"].includes(selection.detail)) fail();
}
