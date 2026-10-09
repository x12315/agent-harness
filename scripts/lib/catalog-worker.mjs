import { applyCatalogJson, applyCatalogMarkdown, createCatalogProfile, deleteCatalogProfile, runCatalogDoctor } from "./catalog-transaction.mjs";

process.once("message", (message) => {
	try {
		const result = message.action === "doctor"
			? runCatalogDoctor(message.repo, message.engine)
			: message.action === "create-profile" ? createCatalogProfile(message.options)
			: message.action === "delete-profile" ? deleteCatalogProfile(message.options)
			: message.action === "save-markdown" ? applyCatalogMarkdown(message.options) : applyCatalogJson(message.options);
		process.send(result, () => process.disconnect());
	} catch (error) {
		process.send({ ok: false, status: 500, error: error instanceof Error ? error.message : String(error) }, () => process.disconnect());
	}
});
