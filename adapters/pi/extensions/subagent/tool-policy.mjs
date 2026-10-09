export function getParentActiveTools(pi) {
	return pi.getActiveTools();
}

export function resolveAgentTools(parentActiveTools, agentTools) {
	const parent = new Set(parentActiveTools.filter((tool) => tool !== "subagent"));
	const requested = agentTools?.length ? agentTools : [...parent];
	return [...new Set(requested.filter((tool) => parent.has(tool)))];
}

export function buildAgentToolArgs(parentActiveTools, agentTools) {
	const activeTools = resolveAgentTools(parentActiveTools, agentTools);
	return activeTools.length > 0 ? ["--tools", activeTools.join(",")] : ["--no-tools"];
}
