import assert from "node:assert/strict";
import { test } from "node:test";
import { statusLabel, gapLabel, taskControlText, taskCounts, elapsedLabel, nativeEvidenceFor } from "./view-utils.mjs";

test("protocol statuses and gaps use plain Chinese without raw English failures", () => {
	assert.equal(statusLabel("running"), "执行中");
	assert.equal(statusLabel("unexpected"), "等待更新");
	for (const gap of ["Wall-clock runtime budget exceeded", "Native connection or snapshot requires reconciliation", "Whole-objective coverage check pending", "Native goal review failed", "Execution permission is not enabled", "Unexpected protocol failure"]) {
		assert.match(gapLabel(gap), /[\u3400-\u9fff]/u);
		assert.doesNotMatch(gapLabel(gap), /Native|Wall-clock|coverage|protocol|Execution/);
	}
	assert.equal(gapLabel("需要确认目标范围"), "需要确认目标范围");
});

test("task controls remain natural-language messages with explicit objective and identity", () => {
	const task = { id: "task-7", objective: "调查超时，不修改部署" };
	for (const action of ["pause", "resume", "cancel"]) {
		const message = taskControlText(action, task);
		assert.ok(message.includes(task.objective));
		assert.ok(message.includes(task.id));
		assert.match(message, /^请(暂停|继续|取消)任务/);
	}
	assert.match(taskControlText("cancel", task), /不要求撤销/);
	assert.throws(() => taskControlText("delete", task), TypeError);
});

test("counts distinguish evidence-backed completion from ended or uncertain execution", () => {
	assert.deepEqual(taskCounts(["running", "stopping", "needs_reconciliation", "queued", "paused", "verified", "failed", "cancelled"].map((status) => ({ status }))), { active: 3, waiting: 2, complete: 1 });
});

test("wall time handles zero, unknown starts and clock skew", () => {
	assert.equal(elapsedLabel(null, 1000), "尚未开始");
	assert.equal(elapsedLabel(0, 125000), "2 分钟");
	assert.equal(elapsedLabel(2000, 1000), "0 秒");
	assert.equal(elapsedLabel(0, 3660000), "1 小时 1 分钟");
});

test("completion evidence remains available without a live handle or globally unique ID", () => {
	const nativeEvidence = { feedback: "检查通过", messages: [{ role: "assistant", text: "实际结果" }] };
	assert.equal(nativeEvidenceFor({ handle: null, nativeReference: { clientId: "host-a", conversationId: "1" }, nativeCompletion: { nativeEvidence }, evidence: { feedback: "older" } }), nativeEvidence);
	assert.deepEqual(nativeEvidenceFor({ evidence: { nativeEvidence } }), nativeEvidence);
	assert.equal(nativeEvidenceFor({}), null);
});
