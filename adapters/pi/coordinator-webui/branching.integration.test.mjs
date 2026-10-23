import assert from 'node:assert/strict';
import test from 'node:test';
import { Coordinator } from './coordinator.mjs';
const until=async(fn)=>{const end=Date.now()+1500;while(!fn()){if(Date.now()>end)throw Error('state transition timeout');await new Promise(done=>setTimeout(done,2));}};
function fixture(saved){
 let disk=saved?structuredClone(saved):null;const starts=[];let classifications=0;
 const coordinator=new Coordinator({storage:{read:async()=>disk,write:async(s)=>{disk=structuredClone(s);}},classify:async()=>{classifications++;return {action:'task',text:'UNEXPECTED CLASSIFICATION'};},executor:{start:async(t)=>{starts.push(t);return {id:t.id};},pause:async()=>({stopped:true}),revise:async()=>({stopped:true}),cancel:async()=>({stopped:true})},maxConcurrent:1});
 return {coordinator,starts,disk:()=>disk,classifications:()=>classifications};
}
const base={schemaVersion:1,nextId:2,paused:false,inputs:[],tasks:[{id:'task-1',revision:1,objective:'调查',sourceText:'调查',amendments:[],constraints:['不修改部署'],acceptance:[],status:'verified',desired:'run',handle:null,nativeCompletion:{revision:1,nativeReview:'passed',nativeEvidence:{executorReport:'finding'}}}]};

test('replayed direct fork request commits once and never invokes classifier',async(t)=>{
 const f=fixture(base);t.after(()=>f.coordinator.dispose());
 const options={requestId:'fork-once',conversationId:'browser-a',operationPlan:{action:'plan',operations:[{action:'fork',targetId:'task-1',expectedRevision:1,text:'独立报告'}]}};
 await f.coordinator.submit('另开报告',options);await f.coordinator.submit('另开报告',options);
 await until(()=>f.starts.length>0);
 assert.equal(f.coordinator.snapshot().tasks.length,2);assert.equal(f.classifications(),0);
 assert.deepEqual(f.starts[0].constraints,['不修改部署']);
 assert.equal(f.starts[0].derivedFrom.taskId,'task-1');
});

test('a persisted pending direct plan replays its contract on restore rather than reclassifying raw prose',async(t)=>{
 const saved=structuredClone(base);saved.nextId=3;saved.inputs.push({id:'input-2',text:'另开报告',status:'pending',conversationId:'a',operationPlan:{action:'plan',operations:[{action:'fork',targetId:'task-1',expectedRevision:1,text:'独立报告'}]}});
 const f=fixture(saved);t.after(()=>f.coordinator.dispose());await f.coordinator.restore();await until(()=>f.coordinator.snapshot().tasks.length===2);
 assert.equal(f.coordinator.snapshot().tasks[1].objective,'独立报告');assert.equal(f.classifications(),0);
});

test('old parent completion cannot close a newly decomposed target',async(t)=>{
 const saved=structuredClone(base);Object.assign(saved.tasks[0],{status:'running',handle:{id:'task-1'},runRevision:1,nativeCompletion:null});
 const f=fixture(saved);t.after(()=>f.coordinator.dispose());await f.coordinator.restore();
 await f.coordinator.submit('拆成后端和前端',{requestId:'split',operationPlan:{action:'plan',operations:[{action:'decompose',targetId:'task-1',expectedRevision:1,children:[{text:'后端'},{text:'前端'}]}]}});
 await f.coordinator.observe('task-1',{revision:1,status:'passed',nativeReview:'passed'});
 assert.notEqual(f.coordinator.snapshot().tasks[0].status,'verified');
});
