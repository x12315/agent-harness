import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("harness-web-models", {
		description: "Export credential-free model metadata for Harness Web",
		handler: async (_args, ctx) => {
			ctx.ui.notify(JSON.stringify(ctx.modelRegistry.getAvailable().map((model) => ({
				provider: model.provider,
				id: model.id,
				name: model.name,
				context: model.contextWindow,
				reasoning: model.reasoning,
				images: model.input?.includes("image") ?? false,
				thinkingLevels: getSupportedThinkingLevels(model),
			}))), "info");
		},
	});
}
