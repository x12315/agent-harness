import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { publicToolParameters } from "../lib/web-catalog.mjs";

function sourceInfo(info: { path: string; source: string; scope: string; origin: string }) {
	return { path: info.path, source: info.source, scope: info.scope, origin: info.origin };
}

/** RPC metadata from public registry APIs; no tool execution, model turn or private settings/auth. */
export default function (pi: ExtensionAPI) {
	const exportMetadata = (ctx: ExtensionContext) => {
		const tools = pi.getAllTools();
		ctx.ui.notify(JSON.stringify({
			type: "harness-web-resources",
			models: ctx.modelRegistry.getAvailable().map((model) => ({
				provider: model.provider,
				id: model.id,
				name: model.name,
				context: model.contextWindow,
				reasoning: model.reasoning,
				images: model.input?.includes("image") ?? false,
				thinkingLevels: getSupportedThinkingLevels(model),
			})),
			warning: tools.length === 0 ? "tools-unavailable" : undefined,
			tools: tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: publicToolParameters(tool.parameters),
				sourceInfo: sourceInfo(tool.sourceInfo),
				annotations: { readOnlyHint: tool.annotations?.readOnlyHint === true },
			})),
			commands: pi.getCommands().filter((command) => command.name !== "harness-web-models").map((command) => ({
				name: command.name,
				description: command.description,
				source: command.source,
				sourceInfo: sourceInfo(command.sourceInfo),
			})),
		}), "info");
		ctx.shutdown();
	};
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "rpc") exportMetadata(ctx);
	});
	pi.registerCommand("harness-web-models", {
		description: "Export credential-free model and resource metadata for Harness Web",
		handler: async (_args, ctx) => exportMetadata(ctx),
	});
}
