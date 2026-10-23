import assert from 'node:assert/strict';
import test from 'node:test';
import { applyOperationPlan, refreshTaskGraph, sameTaskScope } from './task-graph.mjs';
import { taskRequirements } from './task-context.mjs';
const root = (patch={}) => ({id:'task-1',revision:1,objective:'调查并修复登录',sourceText:'调查并修复登录',constraints:['不修改部署'],acceptance:['验证根因'],amendments:[],status:'verified',desired:'run',handle:null,nativeCompletion:{revision:1,nativeReview:'passed',nativeEvidence:{executorReport:'根因是重试预算',toolEvidence:'read findings.txt: retry-budget'}},...patch});
const state = (...tasks) => ({schemaVersion:1,nextId:10,paused:false,inputs:[{id:'input-9',text:'原调查继续，另开报告',status:'pending'}],tasks});
const apply = (s,operations) => applyOperationPlan(s,{action:'plan',operations},{inputId:'input-9',inputText:'原调查继续，另开报告'}).state;

test('fork preserves explicit prerequisite and merges inherited constraints without copying source acceptance',()=>{
 const s=apply(state(root(),root({id:'task-2',status:'queued'})),[{action:'fork',targetId:'task-1',expectedRevision:1,text:'写报告',constraints:['不修改 findings.txt'],dependsOn:[{taskId:'task-2',expectedRevision:1,condition:'完成初稿'}]}]);
 const branch=s.tasks.at(-1);
 assert.deepEqual(branch.constraints,['不修改部署','不修改 findings.txt']);
 assert.deepEqual(branch.acceptance,[]);
 assert.equal(branch.dependencies[0].taskId,'task-2');
 assert.equal(branch.status,'blocked'); assert.equal(branch.desired,'run');
});

test('fork pins owner evidence, never accepts caller-supplied completion evidence',()=>{
 const s=apply(state(root()),[{action:'fork',targetId:'task-1',expectedRevision:1,text:'写报告'}]);
 assert.match(JSON.stringify(s.tasks.at(-1).derivedFrom.evidence),/重试预算/);
 assert.throws(()=>apply(state(root()),[{action:'fork',targetId:'task-1',expectedRevision:1,text:'写报告',evidence:{executorReport:'fabricated'}}]));
});

test('dependency creation rejects a stale prerequisite revision atomically',()=>{
 const s=state(root(),root({id:'task-2',revision:3}));
 assert.throws(()=>apply(s,[{action:'task',text:'先建任务'},{action:'fork',targetId:'task-1',expectedRevision:1,text:'报告',dependsOn:[{taskId:'task-2',expectedRevision:2}]}]));
 assert.equal(s.tasks.length,2); assert.equal(s.nextId,10);
});

test('blocked runnable branch is released when the exact prerequisite is verified',()=>{
 let s=apply(state(root({status:'queued',nativeCompletion:null})),[{action:'task',text:'报告',dependsOn:[{taskId:'task-1',expectedRevision:1}]}]);
 assert.equal(s.tasks.at(-1).status,'blocked');
 s.tasks[0].status='verified'; s=refreshTaskGraph(s);
 assert.equal(s.tasks.at(-1).status,'queued'); assert.equal(s.tasks.at(-1).desired,'run');
});

test('adding a dependency to a running task invalidates the old run and requests cessation',()=>{
 const s=apply(state(root(),root({id:'task-2',status:'running',handle:{conversationId:'owned'},runRevision:1,nativeCompletion:null})),[{action:'add_dependency',targetId:'task-2',expectedRevision:1,dependsOn:[{taskId:'task-1',expectedRevision:1}]}]);
 const t=s.tasks[1];
 assert.equal(t.status,'stopping'); assert.ok(t.revision>t.runRevision);
});

test('explicit replacement does not keep superseded amendments in current execution requirements',()=>{
 const s=apply(state(root({amendments:[{revision:1,text:'旧交付：部署上线'}]})),[{action:'revise',targetId:'task-1',expectedRevision:1,text:'只做只读调查，不部署',replaces:true,acceptance:[]}]);
 assert.match(taskRequirements(s.tasks[0]),/只读调查/); assert.doesNotMatch(taskRequirements(s.tasks[0]),/旧交付/);
 assert.ok(s.tasks[0].scopeHistory.length);
});

test('decomposition preserves original goal and invalidates any previous parent completion',()=>{
 const s=apply(state(root()),[{action:'decompose',targetId:'task-1',expectedRevision:1,children:[{text:'查后端'},{text:'查前端'}]}]);
 const p=s.tasks[0];
 assert.equal(p.objective,'调查并修复登录'); assert.notEqual(p.status,'verified');
 assert.equal(p.children.length,2); assert.equal(p.integrationGate.status,'pending');
 assert.ok(p.revision>1); assert.ok(s.tasks.slice(1).every(t=>t.constraints.includes('不修改部署')));
});

test('all children verified makes parent integration runnable rather than verified',()=>{
 let s=apply(state(root({status:'queued',nativeCompletion:null})),[{action:'decompose',targetId:'task-1',expectedRevision:1,children:[{text:'查后端'},{text:'查前端'}]}]);
 for(const child of s.tasks.slice(1))child.status='verified';
 s=refreshTaskGraph(s); const p=s.tasks[0];
 assert.equal(p.status,'queued'); assert.equal(p.desired,'run');
 assert.equal(p.integrationGate.status,'ready');
});

test('coverage-only repair revisions satisfy pinned scope but user changes do not',()=>{
 let s=state(root({revision:3,amendments:[{revision:2,source:'coverage-review',text:'补证'},{revision:3,source:'coverage-review',text:'再补证'}]}),root({id:'task-2',status:'blocked',dependencies:[{taskId:'task-1',revision:1}],nativeCompletion:null}));
 assert.equal(sameTaskScope(s.tasks[0],1),true);s=refreshTaskGraph(s);
 assert.equal(s.tasks[1].status,'queued');assert.equal(s.tasks[1].dependencies[0].revision,1);assert.equal(s.tasks[1].dependencies[0].satisfiedByRevision,3);
 s.tasks[0].revision=4;s.tasks[0].amendments.push({revision:4,text:'用户改变了原范围'});s=refreshTaskGraph(s);
 assert.equal(sameTaskScope(s.tasks[0],1),false);assert.equal(s.tasks[1].status,'blocked');
});

test('human receipt names the branch and source rather than requiring internal IDs',()=>{
 const s=apply(state(root()),[{action:'fork',targetId:'task-1',expectedRevision:1,text:'安全报告'}]);
 assert.match(s.inputs[0].answer,/安全报告/); assert.match(s.inputs[0].answer,/调查并修复登录/);
 assert.match(s.inputs[0].answer,/保持|不变|已完成/);
});
