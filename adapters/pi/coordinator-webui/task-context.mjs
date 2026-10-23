import { redactTaskText } from "./model-json.mjs";

export const MAX_COORDINATION_MESSAGE_LENGTH = 1800;
const unique = (values) => [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];

/** Amendments after the latest explicit scope replacement; historical requirements stay in the ledger only. */
export function activeTaskAmendments(task) {
	const replacementRevision = Math.max(0, ...(task.amendments || []).filter((item) => item.replaces).map((item) => item.revision || 0));
	return (task.amendments || []).filter((item) => !replacementRevision || item.revision >= replacementRevision);
}

/** Latest owner-approved dependency changes supersede old ordering clauses, never artifact requirements. */
export function taskDependencyPolicy(task) {
	const replacement = Math.max(0, ...(task.amendments || []).filter((item) => item.replaces).map((item) => item.revision || 0));
	const latest = new Map();
	for (const change of [...(task.dependencyPolicyOverrides || []), ...(task.relationHistory || [])].filter((item) => item.revision >= replacement).sort((a,b) => a.revision-b.revision)) {
		for (const dep of change.changedDependencies || []) {
			if (!change.imported) for (const [key,value] of latest) if (value.taskId === dep.taskId) latest.delete(key);
			const ownerTaskId = change.ownerTaskId || task.id;
			latest.set(`${ownerTaskId}:${dep.taskId}`, { action: change.action, revision: change.revision, ownerTaskId, taskId: dep.taskId, sourceRevision: dep.revision, condition: dep.condition, inputId: change.inputId });
		}
	}
	return [...latest.values()];
}

/** Binding scope for one task only; compound intake and source-task deliverables are not inherited. */
export function taskRequirements(task) {
	return unique([
		task.sourceText, task.objective,
		...activeTaskAmendments(task).filter((item) => !["coverage-review", "dependency", "coordination", "coordination-delivery", "decompose", "merge"].includes(item.source)).map((item) => item.text),
		...(task.constraints || []), ...(task.acceptance || []),
	]).join("\n\n");
}

/** Read-only, bounded result excerpts; never export handles or the raw conversation. */
export const nativeEvidenceExcerpt = (value) => value ? {
		feedback: redactTaskText(String(value.feedback || "")).slice(0, 700),
		executorReport: redactTaskText(String(value.executorReport || "")).slice(0, 1800),
		toolEvidence: redactTaskText(String(value.toolEvidence || "")).slice(0, 2200),
	} : undefined;

/** Bounded provenance data for execution; never exports session handles, credentials or raw conversations. */
export function taskRelationContext(task) {
	const evidence = nativeEvidenceExcerpt;
	const source = task.derivedFrom;
	const dependencyPolicy = task.dependencyPolicyChanges || taskDependencyPolicy(task);
	return {
		...(dependencyPolicy.length ? {dependencyPolicyChanges:dependencyPolicy} : {}),
		...(task.ownerFacts && Object.keys(task.ownerFacts).length ? { ownerFacts: { ...(Number.isSafeInteger(task.ownerFacts.prerequisiteCount) ? {prerequisiteCount:task.ownerFacts.prerequisiteCount,allPrerequisitesVerified:task.ownerFacts.allPrerequisitesVerified===true} : {}), ...(task.ownerFacts.source ? { source: { taskId: task.ownerFacts.source.taskId, revision: task.ownerFacts.source.revision, status: task.ownerFacts.source.status, sameScope: task.ownerFacts.source.sameScope, disposition: task.ownerFacts.source.disposition } } : {}), ...(task.ownerFacts.prerequisites?.length ? { prerequisites: task.ownerFacts.prerequisites.map(({taskId,revision,status,pinnedRevision})=>({taskId,revision,status,pinnedRevision})) } : {}) } } : {}),
		...(task.priorWork ? { priorWork: { revision: task.priorWork.revision, evidence: evidence(task.priorWork.evidence) } } : {}),
		...(task.coordinationMessages?.length ? { messages: task.coordinationMessages.slice(0, 8).map(({ id, text, fromTaskIds, fromTasks, origin }) => ({ id, text: String(text), fromTaskIds: (fromTaskIds || []).filter((id) => typeof id === "string"), fromTasks: (fromTasks || []).map(({taskId,revision,objective,snapshotStatus,deliveredSourceRevision,evidence:sourceEvidence}) => ({taskId,revision,objective:String(objective||"").slice(0,600),snapshotStatus,deliveredSourceRevision,excerpt:true,evidence:evidence(sourceEvidence)})), origin })) } : {}),
		...(task.mergeEvidence?.length ? { mergedResults: task.mergeEvidence.slice(0, 16).map((item) => ({ taskId: item.taskId, revision: item.revision, statusAtMerge: item.statusAtMerge, objective: String(item.objective || "").slice(0, 600), evidence: evidence(item.evidence) })) } : {}),
		...(source ? { derivedFrom: { taskId: source.taskId, revision: source.revision, objective: String(source.objective || "").slice(0, 1000), statusAtFork: source.statusAtFork, evidence: evidence(source.evidence) } } : {}),
		...(task.partOf ? { partOf: { taskId: task.partOf.taskId, revision: task.partOf.revision } } : {}),
		...(task.dependencies?.length ? { dependencies: task.dependencies.map(({ taskId, revision, condition }) => ({ taskId, revision, condition })) } : {}),
		...(task.dependencyEvidence?.length ? { prerequisiteResults: task.dependencyEvidence.slice(0, 16).map((item) => ({ taskId: item.taskId, revision: item.revision, objective: String(item.objective || "").slice(0, 600), evidence: evidence(item.evidence) })) } : {}),
	};
}

/** Fit complete messages and honest optional context into a native goal; never cut serialized JSON. */
export function boundedTaskRelationContext(task, limit = 12000) {
	const context = taskRelationContext(task);
	if (context.messages?.some((message) => message.text.length > MAX_COORDINATION_MESSAGE_LENGTH)) {
		const error = new Error("协作消息超过注入容量；未派发，也未宣称完整注入"); error.preDispatch = true; throw error;
	}
	while (JSON.stringify(context).length > limit) {
		const records = [...(context.mergedResults || []), ...(context.prerequisiteResults || []), context.derivedFrom, context.priorWork].filter(Boolean);
		const withEvidence = records.find((item) => item.evidence);
		if (withEvidence) { delete withEvidence.evidence; context.omittedEvidence = true; continue; }
		const withObjective = records.find((item) => item.objective);
		if (withObjective) { delete withObjective.objective; context.omittedEvidence = true; continue; }
		const arrayKey = ["mergedResults", "prerequisiteResults"].find((key) => context[key]?.length > 4);
		if (arrayKey) { context[arrayKey].pop(); context.omittedEvidence = true; continue; }
		if (context.ownerFacts?.prerequisites?.length > 4) { context.ownerFacts.omittedPrerequisiteDetails = context.ownerFacts.prerequisites.length - 4; context.ownerFacts.prerequisites = context.ownerFacts.prerequisites.slice(0, 4); continue; }
		if (context.messages?.length > 1) { context.messages.pop(); context.deferredMessages = (context.deferredMessages || 0) + 1; continue; }
		const error = new Error("关联上下文超过容量；未派发，请缩小一次协作或依赖范围"); error.preDispatch = true; throw error;
	}
	return context;
}
