import assert from 'node:assert/strict';
import test from 'node:test';
import { applyOperationPlan } from './task-graph.mjs';
import { Coordinator } from './coordinator.mjs';
import { taskDependencyPolicy, taskRelationContext, taskRequirements } from './task-context.mjs';
const task=(id,objective,patch={})=>({id,objective,sourceText:objective,revision:1,amendments:[],constraints:[`保护${id}`],acceptance:[`验收${id}`],status:'queued',desired:'run',handle:null,...patch});
const state=(...tasks)=>({schemaVersion:1,nextId:10,paused:false,tasks,inputs:[{id:'input-9',text:'合并并协调',status:'pending'}]});
const merge={action:'merge',targetId:'task-1',expectedRevision:1,sources:[{taskId:'task-2',expectedRevision:1}]};
const apply=(s,operations,id='input-9')=>applyOperationPlan(s,{action:'plan',operations},{inputId:id,inputText:'合并并协调'}).state;

test('merge atomically preserves both scopes, constraints, acceptance, history and redirects dependent work',()=>{
 const initial=state(task('task-1','调查根因'),task('task-2','整理报告'),task('task-3','最终发布',{dependencies:[{taskId:'task-2',revision:1,condition:'报告通过'}]}));
 const s=apply(initial,[merge]);const target=s.tasks[0],source=s.tasks[1],dependent=s.tasks[2];
 assert.match(taskRequirements(target),/调查根因/);assert.match(taskRequirements(target),/整理报告/);
 assert.deepEqual(target.constraints,['保护task-1','保护task-2']);assert.deepEqual(target.acceptance,['验收task-1','验收task-2']);
 assert.equal(source.status,'merged');assert.equal(source.mergeInto,target.id);assert.equal(source.sourceText,'整理报告');
 assert.equal(target.revision,2);assert.equal(target.scopeHistory.length,1);assert.equal(target.mergeEvidence.length,2);
 assert.equal(dependent.dependencies[0].taskId,target.id);assert.equal(dependent.dependencies[0].revision,2);assert.equal(dependent.status,'blocked');
 assert.equal(initial.tasks[1].status,'queued','input is never partially mutated');
});

test('invalid last operation or stale source rolls back an entire mixed rearrangement',()=>{
 const s=state(task('task-1','调查'),task('task-2','报告'));
 assert.throws(()=>apply(s,[merge,{action:'revise',targetId:'task-99',expectedRevision:1,text:'不可执行',replaces:false}]));
 assert.equal(s.tasks[0].revision,1);assert.equal(s.tasks[1].mergeInto,undefined);
 assert.throws(()=>apply(s,[{...merge,sources:[{taskId:'task-2',expectedRevision:2}]}]));
});

test('negotiation proposal never executes itself, and explicit confirmation revalidates every source',()=>{
 let s=apply(state(task('task-1','调查'),task('task-2','报告')),[{action:'propose',text:'两项可合并，待确认',proposedOperations:[merge]}]);
 const proposal=s.proposals[0];assert.equal(s.tasks[1].status,'queued');assert.equal(proposal.status,'pending');
 const stale=structuredClone(s);stale.tasks[1].revision++;
 assert.throws(()=>apply(stale,[{action:'accept_proposal',proposalId:proposal.id,expectedRevision:1}]));
 assert.equal(stale.proposals[0].status,'pending');assert.equal(stale.tasks[0].revision,1);
 s=apply(s,[{action:'accept_proposal',proposalId:proposal.id,expectedRevision:1}]);
 assert.equal(s.proposals[0].status,'accepted');assert.equal(s.tasks[1].status,'merged');
 assert.throws(()=>apply(s,[{action:'accept_proposal',proposalId:proposal.id,expectedRevision:1}]));
});

test('rejecting a proposal leaves all work unchanged and nested automatic approvals are forbidden',()=>{
 let s=apply(state(task('task-1','调查'),task('task-2','报告')),[{action:'propose',text:'待确认合并',proposedOperations:[merge]}]);
 s=apply(s,[{action:'reject_proposal',proposalId:s.proposals[0].id,expectedRevision:1}]);
 assert.equal(s.proposals[0].status,'rejected');assert.equal(s.tasks[0].revision,1);assert.equal(s.tasks[1].mergeInto,undefined);
 assert.throws(()=>apply(s,[{action:'propose',text:'不能自动确认',proposedOperations:[{action:'accept_proposal',proposalId:'anything',expectedRevision:1}]}]));
});

test('mediated messages are data and cannot become completion evidence or expand task acceptance',()=>{
 const s=apply(state(task('task-1','调查'),task('task-2','报告')),[{action:'message',targetId:'task-2',expectedRevision:1,sources:[{taskId:'task-1',expectedRevision:1}],text:'请核对根因，以上结论仍待验证'}]);
 assert.equal(s.messages.length,1);assert.equal(s.messages[0].origin,'coordinator-mediated');assert.equal(s.messages[0].status,'pending');
 assert.equal(s.tasks[1].revision,2);assert.deepEqual(s.tasks[1].acceptance,['验收task-2']);
 assert.doesNotMatch(taskRequirements(s.tasks[1]),/待核对的数据/);
});

test('duplicate goals create a visible overlap notice, not a silent automatic merge',()=>{
 const s=apply(state(task('task-1','调查相同故障')),[{action:'task',text:'调查相同故障'}]);
 assert.equal(s.tasks.length,2);assert.equal(s.negotiations[0].type,'possible-duplicate');assert.ok(s.tasks.every(t=>!t.mergeInto));
});

test('repartitioning and ready-queue ordering are one version-checked batch without changing unrelated goals',()=>{
 const s=apply(state(task('task-1','前端与后端'),task('task-2','重复排查'),task('task-3','其他')),[{action:'revise',targetId:'task-1',expectedRevision:1,text:'仅查后端',replaces:true,acceptance:[]},{action:'revise',targetId:'task-2',expectedRevision:1,text:'仅查前端',replaces:true,acceptance:[]},{action:'reorder',sources:[{taskId:'task-2',expectedRevision:1},{taskId:'task-1',expectedRevision:1}]}]);
 assert.deepEqual(s.tasks.map(t=>t.id),['task-2','task-1','task-3']);assert.equal(s.tasks[0].objective,'仅查前端');assert.equal(s.tasks[1].objective,'仅查后端');assert.equal(s.tasks[2].revision,1);
});

const until=async(fn)=>{const end=Date.now()+1500;while(!fn()){if(Date.now()>end)throw Error('transition timeout');await new Promise(done=>setTimeout(done,2));}};
test('committed merge waits for exact worker cessation before replacement dispatch, including unknown stops',async(t)=>{
 let disk=state(task('task-1','调查',{status:'verified'}),task('task-2','报告',{status:'running',handle:{id:'owned'},runRevision:1}));const starts=[];
 const coordinator=new Coordinator({storage:{read:async()=>disk,write:async(s)=>{disk=structuredClone(s);}},classify:async()=>{throw Error('no model for direct operations');},executor:{start:async(task)=>{starts.push(task);return {id:task.id};},cancel:async()=>({stopped:false}),pause:async()=>({stopped:true}),status:async()=>({revision:1,status:'unknown'})},maxConcurrent:1});
 t.after(()=>coordinator.dispose());await coordinator.restore();
 const options={requestId:'merge-once',operationPlan:{action:'plan',operations:[merge]}};
 await coordinator.submit('合并这两项',options);await coordinator.submit('合并这两项',options);
 await until(()=>coordinator.snapshot().tasks[1].status==='needs_reconciliation');
 assert.equal(starts.length,0);assert.equal(coordinator.snapshot().tasks[0].status,'blocked');
 await coordinator.observe('task-2',{revision:1,status:'stopped',stopped:true});await until(()=>starts.length===1);
 assert.equal(coordinator.snapshot().tasks[1].status,'merged');assert.match(taskRequirements(starts[0]),/报告/);
 assert.equal(starts[0].mergeEvidence.length,2);
});

test('explicit dependency removal remains an authoritative ordering override through merge, but not a later scope replacement',()=>{
 let s=state(task('task-1','调查'),task('task-2','等调查验证后再写报告',{dependencies:[{taskId:'task-1',revision:1,condition:'调查验证完成'}]}));
 s=apply(s,[{action:'remove_dependency',targetId:'task-2',expectedRevision:1,dependsOn:[{taskId:'task-1',expectedRevision:1}]}]);
 assert.equal(s.tasks[1].dependencies.length,0);assert.equal(taskDependencyPolicy(s.tasks[1])[0].action,'remove_dependency');assert.equal(taskRelationContext(s.tasks[1]).dependencyPolicyChanges[0].taskId,'task-1');
 s=apply(s,[{...merge,sources:[{taskId:'task-2',expectedRevision:2}]}],'input-10');
 const policy=taskDependencyPolicy(s.tasks[0]);assert.equal(policy.length,1);assert.equal(policy[0].ownerTaskId,'task-2');assert.equal(policy[0].condition,'调查验证完成');assert.equal(policy[0].action,'remove_dependency');
 s=apply(s,[{action:'revise',targetId:'task-1',expectedRevision:2,replaces:true,acceptance:[],text:'一个明确的新范围'}],'input-11');assert.deepEqual(taskDependencyPolicy(s.tasks[0]),[]);
});
