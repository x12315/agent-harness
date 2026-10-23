const STATUS_LABELS = {
	pending: "已收件", classified: "已安排", question: "已回答", clarify: "需要你补充",
	queued: "等待执行", blocked: "等待依赖", starting: "正在启动", running: "执行中", stopping: "等待停止确认",
	paused: "已暂停", cancelled: "已取消", merged: "已合并", failed: "未通过检查", verified: "已验证完成",
	needs_reconciliation: "需要核对", passed: "已通过", missing: "证据不足", unknown: "尚未确认",
};

/** Translate protocol states without exposing implementation identifiers. */
export function statusLabel(status) { return STATUS_LABELS[status] || "等待更新"; }

/** Convert known execution failures to actionable Chinese, retaining Chinese explanations. */
export function gapLabel(value) {
	if (!value) return "";
	const text = String(value);
	if (/execution.*(?:disabled|permission)|permission.*enabled/i.test(text)) return "执行权限尚未开启；在插件设置中明确开启后，再继续此任务。";
	if (/wall.clock|runtime budget/i.test(text)) return "已达到本轮执行时限，正在等待暂停确认。";
	if (/completed before cancellation/i.test(text)) return "取消确认前任务已经完成，已产生的改动不会自动撤销。";
	if (/coverage.*pending/i.test(text)) return "原生检查已通过，仍在核对原始需求的证据覆盖。";
	if (/coverage/i.test(text)) return "原始需求尚未全部取得有效证据，请查看缺失项；暂不认定整体完成。";
	if (/stop|cessation/i.test(text)) return "已请求停止，但执行侧尚未确认停止；请勿据此认定任务已暂停。";
	if (/review.*(?:fail|not passed)/i.test(text)) return "原生检查尚未通过，请核对执行记录和未完成项。";
	if (/reconcil|unconfirmed|unknown|connection|snapshot|matching native|unavailable/i.test(text)) return "执行状态尚未核实，请刷新查看；核对前不会认定任务完成。";
	if (/[\u3400-\u9fff]/u.test(text)) return text.replace(/^Classification unavailable:\s*/i, "需求判断暂不可用：");
	return "当前步骤未能确认，请刷新核对任务状态，原始需求仍然保留。";
}

/** Task controls are ordinary durable inbox messages, never executor commands. */
export function taskControlText(action, task) {
	const verb = { pause: "暂停", resume: "继续", cancel: "取消" }[action];
	if (!verb) throw new TypeError("Unknown task action");
	return `请${verb}任务「${task.objective}」（任务 ${task.id}）。${action === "cancel" ? "只取消后续执行，不要求撤销已有改动。" : "保留原始需求和所有补充。"}`;
}

/** Render provenance, decomposition and execution dependencies as distinct relationships. */
export function taskRelations(task, tasks = []) {
	const title = (id) => tasks.find((item) => item.id === id)?.objective || "关联任务暂不可用";
	const rows = [];
	if (task.mergeInto) rows.push({ kind: "merged_into", text: `已合并至：${title(task.mergeInto)}；原要求和记录仍保留` });
	for (const id of task.mergeSources || []) rows.push({ kind: "merged_source", text: `合并来源：${title(id)}；全部要求仍需验收` });
	if (task.derivedFrom) rows.push({ kind: "derived_from", text: `分叉来源：${title(task.derivedFrom.taskId)}（版本 ${task.derivedFrom.revision}）` });
	if (task.partOf) rows.push({ kind: "part_of", text: `所属目标：${title(task.partOf.taskId)}` });
	for (const id of task.children || []) rows.push({ kind: "child", text: `子任务：${title(id)}；完成后仍需整体验收` });
	for (const dependency of task.dependencies || []) rows.push({ kind: "depends_on", text: `执行依赖：${title(dependency.taskId)}（版本 ${dependency.revision}${dependency.satisfiedByRevision && dependency.satisfiedByRevision !== dependency.revision ? `，相同任务范围的版本 ${dependency.satisfiedByRevision} 已通过` : ""}）${dependency.condition ? `；${dependency.condition}` : ""}` });
	return rows;
}

/** Count occupied, waiting, and evidenced-complete tasks independently. */
export function taskCounts(tasks = []) {
	return {
		active: tasks.filter((task) => ["starting", "running", "stopping", "needs_reconciliation"].includes(task.status)).length,
		waiting: tasks.filter((task) => ["queued", "blocked", "paused"].includes(task.status)).length,
		complete: tasks.filter((task) => task.status === "verified").length,
	};
}

/** Format elapsed wall time; missing timestamps do not imply a start. */
export function elapsedLabel(start, end = Date.now()) {
	if (start == null || !Number.isFinite(Number(start))) return "尚未开始";
	const seconds = Math.max(0, Math.floor((end - Number(start)) / 1000));
	if (seconds < 60) return `${seconds} 秒`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
	return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分钟`;
}

/** Prefer preserved completion evidence; never infer native identity from a conversation ID. */
export function nativeEvidenceFor(task) {
	return task.nativeCompletion?.nativeEvidence || task.evidence?.nativeEvidence || task.evidence?.native || task.evidence || null;
}
