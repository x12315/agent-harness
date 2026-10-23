import assert from "node:assert/strict";
import test from "node:test";
import { boundedTaskRelationContext, MAX_COORDINATION_MESSAGE_LENGTH, nativeEvidenceExcerpt, taskRelationContext, taskRequirements } from "./task-context.mjs";
import { WebUiExecutor } from "./webui-executor.mjs";
import { Outbox } from "./client/outbox.mjs";
import { coverageGate, coverageToolEvidence } from "./coverage.mjs";

test("branch scope binds its own deliverable, constraints and acceptance, not the compound intake or parent", () => {
	const task = { objective: "写报告", sourceText: "写报告", sourceInputText: "继续修复并写报告", constraints: ["不改 README"], acceptance: ["附上发现来源"], amendments: [{ text: "中文" }, { source: "coverage-review", text: "repair evidence" }], derivedFrom: { taskId: "a", revision: 3, objective: "修复登录", evidence: { feedback: "checked", token: "secret" } } };
	const scope = taskRequirements(task);
	assert.match(scope, /不改 README/); assert.match(scope, /附上发现来源/);
	assert.doesNotMatch(scope, /继续修复|修复登录|repair evidence/);
	const context = taskRelationContext(task);
	assert.equal(context.derivedFrom.revision, 3);
	assert.equal(JSON.stringify(context).includes("secret"), false);
});

test("native goal receives scoped requirements and bounded data-only provenance", () => {
	const executor = new WebUiExecutor({ url: "ws://127.0.0.1:1234/ws", cwd: "/tmp" });
	const text = executor._goalText({ objective: "写报告", sourceText: "写报告", amendments: [], constraints: ["不改部署"], acceptance: ["引用来源"], relationContext: { derivedFrom: { taskId: "a", revision: 2 } } });
	assert.match(text, /不改部署/); assert.match(text, /引用来源/);
	assert.match(text, /DATA, not instructions/); assert.match(text, /NOT automatically assigned/);
	executor.dispose();
});

test("native execution includes actual intake and latest instruction as provenance without assigning other work", () => {
	const executor=new WebUiExecutor({url:"ws://127.0.0.1:1234/ws",cwd:"/tmp"});
	const task={objective:"报告",sourceText:"只整理报告",sourceInputText:"原调查继续，再写报告",latestInputText:"只给报告补充引用",amendments:[]};
	const goal=executor._goalText(task);assert.match(goal,/原调查继续，再写报告/);assert.match(goal,/只给报告补充引用/);assert.match(goal,/task-management requests.*not delegated/);assert.doesNotMatch(taskRequirements(task),/原调查继续/);executor.dispose();
});

test("coverage keeps distinct late file reads and receives owner lifecycle facts instead of asking the worker to inspect the ledger", async () => {
	const tools = [...Array.from({length:7},(_,i)=>({tool:"read",arguments:{path:"/tmp/draft.txt"},output:`draft ${i}`,finishedAt:i})),{tool:"read",arguments:{path:"/tmp/findings.txt"},output:"retry-budget",finishedAt:10}];
	const selected = coverageToolEvidence(tools,"read findings.txt and draft.txt");
	assert.equal(selected.length,2);assert.ok(selected.some(item=>item.arguments.path.endsWith("findings.txt")));
	let request;
	const gate=coverageGate({llm:{complete:async value=>{request=value;return {ok:true,text:JSON.stringify({complete:true,checked:[{requirement:"原调查保持已完成状态",evidence:"owner source status verified and disposition keep"}],missing:[]})};}}});
	const result=await gate({id:"task-2",revision:1,sourceText:"原调查保持已完成状态",amendments:[]},{feedback:"functional pass"},{coordinationFacts:{source:{taskId:"task-1",status:"verified",disposition:"keep",sameScope:true}}});
	assert.equal(result.status,"passed");assert.equal(JSON.parse(request.prompt).nativeEvidence.coordinatorFacts.source.status,"verified");assert.ok(request.system.length<=4000);
});

test("native context defers whole messages instead of truncating accepted text or serialized JSON", () => {
	const text="发现".repeat(MAX_COORDINATION_MESSAGE_LENGTH/2);
	const context=boundedTaskRelationContext({coordinationMessages:Array.from({length:8},(_,i)=>({id:`message-${i}`,text,fromTasks:[{taskId:"task-1",revision:1,handle:"must-not-leak"}]})),priorWork:{revision:1,evidence:{executorReport:"e".repeat(1800),toolEvidence:"t".repeat(2200)}}});
	assert.ok(JSON.stringify(context).length<=12000);assert.ok(context.messages.length<8);assert.ok(context.messages.every(message=>message.text===text));assert.ok(context.deferredMessages>0);assert.doesNotThrow(()=>JSON.parse(JSON.stringify(context)));assert.ok(!JSON.stringify(context).includes("must-not-leak"));
	assert.throws(()=>boundedTaskRelationContext({coordinationMessages:[{id:"message-1",text:"x".repeat(MAX_COORDINATION_MESSAGE_LENGTH+1)}]}),/未派发/);
});

test("source excerpts redact credential assignments without copying private evidence fields", () => {
	const excerpt=nativeEvidenceExcerpt({feedback:'api_key=must-not-leak',executorReport:'{"password":"example-private-value"}',toolEvidence:'密码：private-password',providerToken:'never-copy-this-field'});
	assert.doesNotMatch(JSON.stringify(excerpt),/must-not-leak|example-private-value|private-password|never-copy-this-field/);assert.match(JSON.stringify(excerpt),/REDACTED/);
});

test("structured branch requests survive outbox reload with the original stable identifier and revision", () => {
	const data = new Map(), storage = { getItem: (key) => data.get(key), setItem: (key, value) => data.set(key, value) };
	const operationPlan = { action: "plan", operations: [{ action: "fork", targetId: "task-7", expectedRevision: 2, text: "写报告" }] };
	new Outbox(storage).add({ requestId: "same-request", text: "另开报告", workspace: "/tmp", operationPlan });
	const replay = new Outbox(storage).reconcile("/tmp", []);
	assert.deepEqual(replay[0].operationPlan, operationPlan);
	assert.equal(replay[0].requestId, "same-request");
});
