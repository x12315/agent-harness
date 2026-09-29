import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function resolvedProfileExtensions(): { id: string; entry: string }[] | undefined {
	const runtimeDir = process.env.PI_CODING_AGENT_DIR;
	if (!runtimeDir) return undefined;
	try {
		const state = JSON.parse(readFileSync(join(runtimeDir, "pi-profile.json"), "utf8"));
		return state.resolved?.extensions
			?.map((extension: { id: string; entry: string }) => ({ id: extension.id, entry: extension.entry }))
			.sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));
	} catch {
		return undefined;
	}
}

/** Exposes effective Pi runtime state to the read-only harness canary. */
export default function runtimeProbe(pi: ExtensionAPI) {
	pi.registerCommand("harness-runtime-probe", {
		description: "Internal harness verification probe",
		handler: async (encodedInstruction, ctx) => {
			const allTools = pi.getAllTools();
			const builtinTools = allTools
				.filter((tool) => tool.sourceInfo.source === "builtin")
				.map((tool) => tool.name)
				.sort();
			const toolSources = allTools.map((tool) => ({
				name: tool.name,
				source: tool.sourceInfo.source,
				path: tool.sourceInfo.path,
			}));
			let instructionPresent = true;
			try {
				const expected = Buffer.from(encodedInstruction.trim(), "base64").toString("utf8");
				if (expected) instructionPresent = ctx.getSystemPrompt().includes(expected);
			} catch {
				instructionPresent = false;
			}
			ctx.ui.notify(JSON.stringify({
				activeTools: [...pi.getActiveTools()].sort(),
				builtinTools,
				instructionPresent,
				model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
				thinking: ctx.thinkingLevel,
				resolvedExtensions: resolvedProfileExtensions(),
				toolSources,
			}), "info");
		},
	});
}
