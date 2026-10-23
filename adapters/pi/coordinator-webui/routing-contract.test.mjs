import assert from "node:assert/strict";
import test from "node:test";
import { intentClassifier, normalizeRoutingResult } from "./index.mjs";
import { routingPrompt } from "./model-json.mjs";

const task = (id, objective, extra = {}) => ({ id, objective, status: "paused", revision: 3, amendments: [], constraints: [], acceptance: [], ...extra });

test("retrieves an older named task ahead of persisted current focus", () => {
 const snapshot = {
  focusByConversation: { browser: { taskIds: ["task-39"] } },
  inputs: [],
  tasks: [
   task("task-2", "调查分页空数组的旧问题", { revision: 4, amendments: [{ revision: 4, text: "补充检查 API 返回关系" }], constraints: ["只读验证"], acceptance: ["记录复现证据"] }),
   ...Array.from({ length: 38 }, (_, index) => task(`task-${index + 3}`, `其他工作 ${index}`)),
   task("task-39", "整理无关的部署报告"),
  ],
 };
 const parsed = JSON.parse(routingPrompt({ conversationId: "browser", text: "继续调查分页空数组的旧问题" }, snapshot));
 assert.equal(parsed.taskCandidates[0].id, "task-2");
 assert.equal(parsed.taskCandidates[0].amendments[0].text, "补充检查 API 返回关系");
 assert.deepEqual(parsed.taskCandidates[0].constraints, ["只读验证"]);
 assert.deepEqual(parsed.taskCandidates[0].acceptance, ["记录复现证据"]);
});

test("keeps clarification context within the same conversation", () => {
 const parsed = JSON.parse(routingPrompt({ conversationId: "browser-a", text: "是报告那项" }, {
  tasks: [task("task-1", "调查登录")],
  inputs: [
   { id: "input-old", conversationId: "browser-a", acceptedAt: 1, status: "clarify", text: "你指调查还是报告？", answer: "请明确目标" },
   { id: "input-other", conversationId: "browser-b", acceptedAt: 2, status: "clarify", text: "跨会话不应进入", answer: "不要泄露" },
  ],
 }));
 assert.equal(parsed.sameConversationRecentInputs.length, 1);
 assert.equal(parsed.sameConversationRecentInputs[0].id, "input-old");
 assert.equal(parsed.sameConversationRecentInputs[0].pendingClarification, true);
 assert.doesNotMatch(JSON.stringify(parsed), /跨会话不应进入|不要泄露/);
});

test("preserves scoped plan text and never manufactures an existing revision", () => {
 const input = { text: "继续调查；另外写一份报告并暂停部署。" };
 const snapshot = { tasks: [task("task-1", "调查", { revision: 7 })] };
 const plan = normalizeRoutingResult({ action: "plan", operations: [
  { action: "revise", targetId: "task-1", expectedRevision: 7, text: "补查空数组", replaces: false },
  { action: "task", ref: "report", text: "根据已确认调查写报告" },
  { action: "pause", targetId: "task-1", expectedRevision: 7 },
 ] }, input, snapshot);
 assert.equal(plan.operations[0].text, "补查空数组");
 assert.equal(plan.operations[1].text, "根据已确认调查写报告");
 assert.notEqual(plan.operations[0].text, input.text);
 assert.throws(() => normalizeRoutingResult({ action: "plan", operations: [{ action: "pause", targetId: "task-1" }] }, input, snapshot), /目标版本/);
});

test("rejects injected authority fields and accepts a clarification answer", async () => {
 const snapshot = { inputs: [], tasks: [task("task-1", "调查登录")] };
 assert.throws(() => normalizeRoutingResult({ action: "plan", operations: [{ action: "task", text: "写报告", permissions: ["admin"] }] }, { text: "写报告" }, snapshot), /Unsupported/);
 const classifier = intentClassifier({ llm: { complete: async () => ({ ok: true, text: JSON.stringify({ action: "clarify", text: "请确认是调查还是报告", answer: "请确认目标" }) }) } });
 const result = await classifier({ text: "继续那个", conversationId: "browser" }, snapshot);
 assert.deepEqual(result, { action: "clarify", text: "请确认是调查还是报告", answer: "请确认目标" });
});

test("routing context stays within the native limit and excludes handles and secrets", () => {
 const input = { conversationId: "browser", text: "\\\"".repeat(8000) };
 const prompt = routingPrompt(input, { inputs: [], tasks: Array.from({ length: 100 }, (_, index) => task(`task-${index}`, `${input.text} secret=do-not-send`, { handle: { token: "handle-do-not-send" } })) });
 assert.ok(prompt.length <= 8000);
 assert.doesNotMatch(prompt, /handle-do-not-send|do-not-send/);
});
