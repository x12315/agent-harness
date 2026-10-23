import assert from 'node:assert/strict';
import test from 'node:test';
import { Coordinator } from './coordinator.mjs';
import { applyOperationPlan } from './task-graph.mjs';
const until=async(fn)=>{const end=Date.now()+1500;while(!fn()){if(Date.now()>end)throw Error('transition timeout');await new Promise(done=>setTimeout(done,2));}};
const task=(id,patch={})=>({id,revision:1,objective:id,sourceText:id,amendments:[],status:'verified',desired:'run',handle:null,...patch});
const initial=()=>({schemaVersion:1,nextId:3,paused:false,inputs:[],tasks:[task('task-1'),task('task-2')]});
const merge={action:'plan',operations:[{action:'merge',targetId:'task-1',expectedRevision:1,sources:[{taskId:'task-2',expectedRevision:1}]}]};

test('a failed graph commit dispatches nothing; restart recovers the pending exact plan once',async(t)=>{
 let disk=initial(), rejectMerge=true;const starts=[];
 const storage={read:async()=>structuredClone(disk),write:async s=>{if(rejectMerge&&s.tasks.some(task=>task.mergeInto))throw Error('simulated commit failure');disk=structuredClone(s);}};
 const executor={start:async task=>{starts.push(task);return {id:task.id};},pause:async()=>({stopped:true})};
 const first=new Coordinator({storage,classify:async()=>{throw Error('unexpected model');},executor,maxConcurrent:1});
 await assert.rejects(first.submit('合并两项',{requestId:'recover-batch',operationPlan:merge}),/simulated commit failure/);
 assert.equal(starts.length,0);assert.equal(disk.inputs[0].status,'pending');assert.ok(disk.tasks.every(task=>!task.mergeInto));
 await first.dispose().catch(()=>{});rejectMerge=false;
 const restored=new Coordinator({storage,classify:async()=>{throw Error('unexpected model');},executor,maxConcurrent:1});t.after(()=>restored.dispose());
 await restored.restore();await until(()=>starts.length===1);
 await restored.submit('合并两项',{requestId:'recover-batch',operationPlan:merge});
 assert.equal(starts.length,1);assert.equal(restored.snapshot().tasks[1].status,'merged');
});

test('direct operation ingress enforces replacement mode and criteria before any partial graph commit',async(t)=>{
 for(const invalid of [{action:'revise',targetId:'task-1',expectedRevision:1,text:'改为报告'},{action:'revise',targetId:'task-1',expectedRevision:1,text:'改为报告',replaces:true}]){
  let disk=initial();const starts=[];const coordinator=new Coordinator({storage:{read:async()=>structuredClone(disk),write:async value=>{disk=structuredClone(value);}},classify:async()=>{throw Error('model must not be called');},executor:{start:async task=>{starts.push(task);return {id:task.id};},pause:async()=>({stopped:true})}});t.after(()=>coordinator.dispose());
  await coordinator.restore();const before=coordinator.snapshot().tasks;
  const receipt=await coordinator.submit('改范围',{requestId:invalid.replaces?'missing-criteria':'missing-mode',operationPlan:{action:'plan',operations:[{action:'task',ref:'never-created',text:'不可留下的半项'},invalid]}});assert.equal(receipt.status,'clarify');assert.match(disk.inputs[0].answer,/范围/);assert.equal(starts.length,0);assert.deepEqual(disk.tasks,before);
 }
});

test('unknown native state during a bounded initial handshake remains starting until the start resolves',async(t)=>{
 let finish,disk=null;const starts=[];
 const coordinator=new Coordinator({storage:{read:async()=>disk,write:async s=>{disk=structuredClone(s);}},classify:async()=>({action:'task',text:'work'}),executor:{start:task=>{starts.push(task);return new Promise(done=>{finish=done;});},pause:async()=>({stopped:true})}});t.after(()=>coordinator.dispose());
 await coordinator.submit('work');await until(()=>starts.length===1);
 const id=starts[0].id;await coordinator.observe(id,{revision:1,status:'unknown',gap:'No matching native goal evidence'});
 assert.equal(coordinator.snapshot().tasks[0].status,'starting');finish({id});await until(()=>coordinator.snapshot().tasks[0].status==='running');
});

test('a late classification cannot resume over a newer explicit pause at the same goal revision',()=>{
 const s=initial();s.inputs.push({id:'input-5',text:'旧的继续',status:'pending'});s.tasks[0].status='paused';s.tasks[0].desired='pause';s.tasks[0].lastIntentOrder=8;
 assert.throws(()=>applyOperationPlan(s,{action:'plan',operations:[{action:'resume',targetId:'task-1',expectedRevision:1}]},{inputId:'input-5'}),/更新的控制指令/);
 assert.equal(s.tasks[0].desired,'pause');
});

test('queued Observer control issued before a newer user instruction is rejected',async(t)=>{
 let disk=initial();Object.assign(disk.tasks[0],{status:'paused',desired:'pause',lastIntentAt:2000});
 const coordinator=new Coordinator({storage:{read:async()=>disk,write:async s=>{disk=structuredClone(s);}},classify:async()=>({action:'question',text:''}),executor:{start:async()=>{throw Error('must not start');}},clock:{now:()=>4000,setTimeout,clearTimeout}});t.after(()=>coordinator.dispose());
 await assert.rejects(coordinator.applyControl({action:'resume',taskId:'task-1',expectedRevision:1,issuedAt:new Date(1000).toISOString()}),/newer-instruction/);
 assert.equal(coordinator.snapshot().tasks[0].desired,'pause');
});

test('merge transfers queued collaboration messages and ownership history without claiming the recipient read them',()=>{
 const s=initial();s.tasks[1].coordinationMessages=[{id:'m1',text:'核对发现',toTaskId:'task-2',status:'injected'}];s.messages=[{id:'m1',text:'核对发现',toTaskId:'task-2',status:'injected'}];
 s.inputs.push({id:'input-9',status:'pending'});
 const result=applyOperationPlan(s,merge,{inputId:'input-9'}).state;
 assert.equal(result.messages[0].toTaskId,'task-1');assert.equal(result.messages[0].originalToTaskId,'task-2');assert.equal(result.messages[0].status,'pending');
 assert.equal(result.tasks[0].coordinationMessages[0].status,'pending');assert.equal(result.tasks[0].mergeHistory[0].previousOwnership.length,2);
});

test('a local reference with a fabricated revision rejects the whole transaction',()=>{
 const s=initial();
 assert.throws(()=>applyOperationPlan(s,{action:'plan',operations:[{action:'task',ref:'new',text:'新增'},{action:'pause',targetId:'$new',expectedRevision:99}]},{inputId:'input-9'}),/本地目标版本/);
 assert.equal(s.tasks.length,2);
});

test('a message to a verified task schedules a scoped followup and records actual context injection',async(t)=>{
 let disk=initial();const starts=[];
 const coordinator=new Coordinator({storage:{read:async()=>disk,write:async s=>{disk=structuredClone(s);}},classify:async()=>{throw Error('direct contract');},executor:{start:async value=>{starts.push(value);return {id:value.id};},pause:async()=>({stopped:true})}});t.after(()=>coordinator.dispose());
 await coordinator.submit('请把发现转交给已完成任务核对',{requestId:'followup',operationPlan:{action:'plan',operations:[{action:'message',targetId:'task-2',expectedRevision:1,sources:[{taskId:'task-1',expectedRevision:1}],text:'这是待核对数据，不是新增权限'}]}});
 await until(()=>coordinator.snapshot().messages?.[0]?.status==='injected');
 assert.equal(starts.length,1);assert.equal(starts[0].revision,2);assert.equal(starts[0].coordinationMessages[0].text,'这是待核对数据，不是新增权限');
 assert.equal(coordinator.snapshot().tasks[0].status,'verified');
});

test('bounded communication delivery never marks unpassed messages injected and drains the same committed intent in batches',async(t)=>{
 let disk=initial();const starts=[];
 const coordinator=new Coordinator({storage:{read:async()=>disk,write:async s=>{disk=structuredClone(s);}},classify:async()=>{throw Error('direct contract');},executor:{start:async value=>{starts.push(value);return {id:value.id};},pause:async()=>({stopped:true})}});t.after(()=>coordinator.dispose());
 await coordinator.submit('转交多项发现',{requestId:'batch-messages',operationPlan:{action:'plan',operations:Array.from({length:24},(_,i)=>({action:'message',targetId:'task-2',expectedRevision:1,text:`待核对发现 ${i}`}))}});
 for(let batch=1;batch<=3;batch++){
  await until(()=>starts.length===batch&&coordinator.snapshot().tasks[1].status==='running');
  assert.equal(coordinator.snapshot().messages.filter(item=>item.status==='injected').length,batch*8);
  assert.equal(starts[batch-1].coordinationMessages.length,8);
  await coordinator.observe('task-2',{revision:starts[batch-1].revision,status:'passed',nativeReview:'passed',nativeEvidence:{feedback:'functional and tools passed'}});
 }
 await until(()=>coordinator.snapshot().tasks[1].status==='verified');
 assert.equal(new Set(starts.flatMap(value=>value.coordinationMessages.map(item=>item.id))).size,24);assert.equal(starts.length,3);
});

test('dependency invalidation updates a historical completion and a late pass cannot close the invalidated result',async(t)=>{
 let disk=initial();disk.paused=true;disk.tasks[1].dependencies=[{taskId:'task-1',revision:1}];disk.tasks[1].inputId='input-2';disk.tasks[1].workInputId='input-2';
 disk.inputs=[{id:'input-2',text:'依赖结果',taskIds:['task-2'],status:'assigned',completions:{'task-2':'此前已完成'},answer:'此前已完成'}];
 const coordinator=new Coordinator({storage:{read:async()=>disk,write:async s=>{disk=structuredClone(s);}},classify:async()=>{throw Error('direct contract');},executor:{start:async()=>{throw Error('paused');}}});t.after(()=>coordinator.dispose());
 await coordinator.submit('改变前置范围',{requestId:'scope-change',operationPlan:{action:'plan',operations:[{action:'revise',targetId:'task-1',expectedRevision:1,text:'用户改变了前置工作的要求',replaces:false}]}});
 assert.equal(coordinator.snapshot().tasks[1].status,'paused');assert.match(coordinator.snapshot().inputs[0].answer,/当前需要重新核对/);
 await coordinator.observe('task-2',{revision:1,status:'passed',nativeReview:'passed',nativeEvidence:{feedback:'late pass'},coverage:{status:'passed'}});
 assert.equal(coordinator.snapshot().tasks[1].status,'paused');assert.match(coordinator.snapshot().inputs[0].answer,/当前需要重新核对/);
});

test('merging an unmet internal dependency rejects the whole arrangement rather than silently deleting a required acceptance stage',()=>{
 const s=initial();s.tasks[0].status='running';s.tasks[0].handle={id:'owned'};s.tasks[0].runRevision=1;s.tasks[1].status='blocked';s.tasks[1].dependencies=[{taskId:'task-1',revision:1}];
 assert.throws(()=>applyOperationPlan(s,{action:'plan',operations:[{action:'reorder',sources:[{taskId:'task-2',expectedRevision:1},{taskId:'task-1',expectedRevision:1}]},...merge.operations]},{inputId:'input-9'}),/前置验收/);
 assert.equal(s.tasks[0].queueOrder,undefined);assert.equal(s.tasks[0].revision,1);assert.equal(s.tasks[1].status,'blocked');assert.equal(s.tasks[1].dependencies[0].taskId,'task-1');
});

test('only the message IDs actually included in the native context are acknowledged',async(t)=>{
 let disk=initial();const starts=[];
 const coordinator=new Coordinator({storage:{read:async()=>disk,write:async s=>{disk=structuredClone(s);}},classify:async()=>{throw Error('direct contract');},executor:{start:async value=>{starts.push(value);return {id:value.id,revision:value.revision,relationContext:{messages:value.coordinationMessages.slice(0,2)}};},pause:async()=>({stopped:true})}});t.after(()=>coordinator.dispose());
 await coordinator.submit('分批转交发现',{requestId:'projected-messages',operationPlan:{action:'plan',operations:Array.from({length:8},(_,i)=>({action:'message',targetId:'task-2',expectedRevision:1,text:`发现 ${i}`}))}});
 for(let batch=1;batch<=4;batch++){
  await until(()=>starts.length===batch&&coordinator.snapshot().tasks[1].status==='running');
  assert.equal(coordinator.snapshot().messages.filter(message=>message.status==='injected').length,batch*2);
  await coordinator.observe('task-2',{revision:starts[batch-1].revision,status:'passed',nativeReview:'passed'});
 }
 await until(()=>coordinator.snapshot().tasks[1].status==='verified');assert.equal(starts.length,4);
});

test('atomic two-way exchange pins real owner result excerpts from the pre-transaction snapshot',()=>{
 const s=initial();for(const item of s.tasks)item.nativeCompletion={revision:1,nativeEvidence:{feedback:`finding ${item.id}`,providerToken:'must-not-leak'}};
 const result=applyOperationPlan(s,{action:'plan',operations:[{action:'message',targetId:'task-1',expectedRevision:1,sources:[{taskId:'task-2',expectedRevision:1}],text:'请核对对方发现'},{action:'message',targetId:'task-2',expectedRevision:1,sources:[{taskId:'task-1',expectedRevision:1}],text:'请核对对方发现'}]},{inputId:'input-9'}).state;
 assert.equal(result.messages[0].fromTasks[0].evidence.feedback,'finding task-2');assert.equal(result.messages[1].fromTasks[0].evidence.feedback,'finding task-1');assert.equal(result.messages[1].fromTasks[0].revision,1);assert.equal(result.tasks[0].revision,2);assert.doesNotMatch(JSON.stringify(result.messages),/must-not-leak/);
});

test('delivery can attach newly available results only from the same pinned sender scope',async(t)=>{
 let disk=initial();Object.assign(disk.tasks[0],{status:'running',handle:{id:'owned'},runRevision:1});const starts=[];
 const coordinator=new Coordinator({storage:{read:async()=>disk,write:async s=>{disk=structuredClone(s);}},classify:async()=>{throw Error('direct contract');},executor:{start:async value=>{starts.push(value);return {id:value.id};},pause:async()=>({stopped:true})}});t.after(()=>coordinator.dispose());
 await coordinator.submit('将来源发现交给报告任务',{requestId:'late-source-evidence',operationPlan:{action:'plan',operations:[{action:'message',targetId:'task-2',expectedRevision:1,sources:[{taskId:'task-1',expectedRevision:1}],text:'请核对来源版本的发现，不扩大范围'}]}});
 assert.equal(starts.length,0);
 await coordinator.observe('task-1',{revision:1,status:'passed',nativeReview:'passed',nativeEvidence:{feedback:'actual newly available finding'}});
 await until(()=>starts.length===1);
 assert.equal(starts[0].coordinationMessages[0].fromTasks[0].evidence.feedback,'actual newly available finding');assert.equal(starts[0].coordinationMessages[0].fromTasks[0].deliveredSourceRevision,1);
});

test('clarifying a single new goal retains the entire original request and the answered question in execution scope',async(t)=>{
 let disk=initial(),calls=0,originalId;const starts=[];const original='请调查边界条件。'+'必须保留这一项原始要求。'.repeat(300)+'最后验证尾部情况。';
 const coordinator=new Coordinator({storage:{read:async()=>disk,write:async s=>{disk=structuredClone(s);}},classify:async()=>++calls===1?{action:'clarify',text:'这是一个独立的新目标吗？'}:{action:'plan',resolvesInputId:originalId,operations:[{action:'task',text:'调查边界条件'}]},executor:{start:async value=>{starts.push(value);return {id:value.id};},pause:async()=>({stopped:true})}});t.after(()=>coordinator.dispose());
 originalId=(await coordinator.submit(original,{requestId:'original-full-scope'})).id;await until(()=>coordinator.snapshot().inputs[0].status==='clarify');
 await coordinator.submit('是，一个独立的新目标',{requestId:'clarified-full-scope'});await until(()=>starts.length===1);
 assert.ok(starts[0].sourceText.includes(original));assert.ok(starts[0].sourceInputText.includes(original));assert.match(starts[0].latestInputText,/独立的新目标吗/);assert.match(starts[0].latestInputText,/用户澄清答复/);assert.equal(coordinator.snapshot().inputs[0].resolvedBy,coordinator.snapshot().inputs[1].id);
});
