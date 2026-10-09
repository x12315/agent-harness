import { readFileSync, readdirSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

/** Plan save-time checks from the actual source diff, never from a client-supplied tier.
 * Full regression, dependency and hygiene checks remain the independent doctor gate.
 * Reverse before/after to plan verification of a rollback.
 */
export function planCatalogValidation({ repo, source, before, after }) {
	const path = relative(resolve(repo), resolve(source)).split("\\").join("/");
	const runtime = { pi: [], codex: [] };
	const add = (name, adapters = ["pi", "codex"]) => {
		for (const adapter of adapters) runtime[adapter].push(name);
	};
	let project = false;
	let kind = "metadata";
	if (path.startsWith("profiles/")) {
		const name = basename(source, ".json");
		const oldValue = before === null ? null : JSON.parse(before);
		const newValue = after === null ? null : JSON.parse(after);
		if (!oldValue || !newValue) {
			kind = "lifecycle";
			project = true;
			if (newValue) add(name);
		} else {
			if (!isDeepStrictEqual(oldValue.instructions, newValue.instructions) || !isDeepStrictEqual(oldValue.skills, newValue.skills)) add(name);
			for (const adapter of ["pi", "codex"]) {
				if (!isDeepStrictEqual(oldValue.adapters?.[adapter], newValue.adapters?.[adapter])) add(name, [adapter]);
			}
			if (runtime.pi.length || runtime.codex.length) kind = "runtime";
		}
	} else {
		kind = "instructions";
		const profiles = readdirSync(join(repo, "profiles")).filter((file) => file.endsWith(".json") && file !== "profile.schema.json")
			.map((file) => ({ name: basename(file, ".json"), value: JSON.parse(readFileSync(join(repo, "profiles", file), "utf8")) }));
		if (path === "instructions/selection.json") {
			if (!isDeepStrictEqual(JSON.parse(before), JSON.parse(after))) for (const profile of profiles) add(profile.name);
		} else if (before?.trim() !== after?.trim()) {
			const match = path.match(/^instructions\/(.+?)(?:\.(brief|detailed))?\.md$/);
			if (!match) throw new Error("Unsupported instruction source");
			const [, id, variant] = match;
			const detail = variant ?? "standard";
			const uses = (selections = []) => selections.some((entry) => entry.id === id && entry.detail === detail);
			if (id.startsWith("profile/")) {
				for (const profile of profiles) if (uses(profile.value.instructions)) add(profile.name);
			} else {
				const global = JSON.parse(readFileSync(join(repo, "instructions/selection.json"), "utf8"));
				if (uses([...(global.mandatory ?? []), ...(global.repository ?? [])])) for (const profile of profiles) add(profile.name);
			}
		}
	}
	for (const adapter of ["pi", "codex"]) runtime[adapter] = [...new Set(runtime[adapter])].sort();
	const steps = [{ name: "compose", args: ["compose", "--apply"], timeout: 60_000 }];
	if (project) steps.push({ name: "bootstrap", args: ["bootstrap", "--apply"], timeout: 60_000 });
	steps.push({ name: "catalog", args: ["verify", "--catalog"], timeout: 60_000 });
	for (const adapter of ["pi", "codex"]) {
		if (runtime[adapter].length) steps.push({
			name: `${adapter}: ${runtime[adapter].join(", ")}`,
			args: ["verify", `--runtime=${adapter}`, ...runtime[adapter].map((name) => `--profile=${name}`)],
			timeout: 600_000,
		});
	}
	return { kind, runtime, project, steps, full: false };
}
