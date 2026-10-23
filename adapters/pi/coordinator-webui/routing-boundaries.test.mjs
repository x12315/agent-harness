import assert from 'node:assert/strict';
import test from 'node:test';
import { routingPrompt } from './model-json.mjs';
import { intentClassifier, normalizeRoutingResult, routingContextPrompt } from './index.mjs';

test('one bounded model-assisted synonym lookup retrieves old work without mutating or inventing task IDs',async()=>{
 const snapshot={tasks:[{id:'task-1',revision:2,status:'paused',objective:'登录故障调查'},...Array.from({length:60},(_,i)=>({id:`task-${i+2}`,revision:1,status:'paused',objective:`其他工作 ${i}`}))],inputs:[]};
 const prompts=[];
 const classify=intentClassifier({llm:{complete:async request=>{assert.ok(request.system.length<4000);prompts.push(JSON.parse(request.prompt));return {ok:true,text:JSON.stringify(prompts.length===1?{action:'lookup',queries:['登录','认证'],text:''}:{action:'plan',operations:[{action:'resume',targetId:'task-1',expectedRevision:2}]})};}}});
 const result=await classify({text:'继续登不进去的那个旧工作',conversationId:'a'},snapshot);
 assert.equal(prompts.length,2);assert.equal(prompts[1].taskCandidates[0].id,'task-1');assert.equal(result.operations[0].targetId,'task-1');assert.equal(snapshot.tasks[0].status,'paused');
});

test('a repeated lookup request is bounded and returns clarification instead of looping',async()=>{
 let calls=0;const classify=intentClassifier({llm:{complete:async()=>{calls++;return {ok:true,text:'{"action":"lookup","queries":["旧工作"]}'};}}});
 const result=await classify({text:'继续旧工作'},{tasks:[],inputs:[]});assert.equal(calls,2);assert.equal(result.action,'clarify');
});

test('read-only context pages retrieve the omitted middle with stable identity and never expose native handles',async()=>{
 const source='前文'.repeat(1800)+'必须保留移动端检查'+'后文'.repeat(1800);const snapshot={tasks:[{id:'task-1',revision:3,status:'paused',objective:'报告',sourceText:source,handle:{token:'must-not-leak'}}],inputs:[]};
 let calls=0;const classify=intentClassifier({llm:{complete:async request=>{assert.ok(request.system.length<=4000);assert.ok(request.prompt.length<=8000);calls++;if(calls===1)return {ok:true,text:'{"action":"read_context","taskId":"task-1","field":"requirements","query":"移动端"}'};const page=JSON.parse(request.prompt).contextPage;assert.equal(page.revision,3);assert.ok(page.text.includes('必须保留移动端检查'));assert.ok(page.offset>0);assert.ok(page.hasMore);assert.ok(!request.prompt.includes('must-not-leak'));return {ok:true,text:'{"action":"plan","operations":[{"action":"revise","targetId":"task-1","expectedRevision":3,"text":"移动端检查改为真实手机验证，其他要求保留","replaces":false}]}'};}}});
 const result=await classify({text:'更新报告里移动端的检查方式'},snapshot);assert.equal(calls,2);assert.equal(result.operations[0].targetId,'task-1');assert.equal(snapshot.tasks[0].revision,3);
 const next=JSON.parse(routingContextPrompt({text:'查看报告原文'},snapshot,{taskId:'task-1',field:'requirements',offset:0}));assert.equal(next.contextPage.offset,0);assert.ok(next.contextPage.end<=3500);
});

test('a semantically single new operation uses the same validated atomic envelope even when the model omits plan wrapping',()=>{
 const snapshot={tasks:[{id:'task-1',revision:1},{id:'task-2',revision:1}],inputs:[]};
 const message=normalizeRoutingResult({action:'message',targetId:'task-2',expectedRevision:1,text:'请核对发现',sources:[{taskId:'task-1',expectedRevision:1}]},{text:'转交发现'},snapshot);assert.equal(message.action,'plan');assert.equal(message.operations[0].action,'message');
 const stale=normalizeRoutingResult({action:'pause',targetId:'task-1',expectedRevision:99},{text:'暂停调查'},snapshot);assert.equal(stale.operations[0].expectedRevision,99,'explicit revisions are never silently replaced by the current snapshot revision');
 const proposal=normalizeRoutingResult({action:'propose',text:'等确认后合并',proposedOperations:[{action:'merge',targetId:'task-1',expectedRevision:1,sources:[{taskId:'task-2',expectedRevision:1}]}]},{text:'先给方案'},snapshot);assert.equal(proposal.operations[0].action,'propose');assert.equal(proposal.operations[0].proposedOperations[0].action,'merge');
});

test('a model guess of a real but unobserved task ID triggers a factual read before any executable verdict',async()=>{
 const snapshot={tasks:[{id:'task-1',revision:1,status:'paused',objective:'身份认证超时调查'},...Array.from({length:160},(_,i)=>({id:`task-${i+2}`,revision:1,status:'paused',objective:`其他账目 ${i}`}))],inputs:[]};let calls=0;
 const classify=intentClassifier({llm:{complete:async request=>{const data=JSON.parse(request.prompt);if(++calls===1)assert.ok(!data.taskCandidates.some(task=>task.id==='task-1'));else assert.equal(data.contextPage.taskId,'task-1');return {ok:true,text:'{"action":"resume","targetId":"task-1","expectedRevision":1}'};}}});
 const result=await classify({text:'上回登不进去的工作继续'},snapshot);assert.equal(calls,2);assert.equal(result.operations[0].targetId,'task-1');assert.equal(snapshot.tasks[0].status,'paused');
});

test('scope updates cannot silently default a reduction to an additive amendment or retain withdrawn acceptance',()=>{
 const snapshot={tasks:[{id:'task-1',revision:1}],inputs:[]};
 assert.throws(()=>normalizeRoutingResult({action:'plan',operations:[{action:'revise',targetId:'task-1',expectedRevision:1,text:'只写报告不修复'}]}, {},snapshot),/replaces/);
 assert.throws(()=>normalizeRoutingResult({action:'plan',operations:[{action:'revise',targetId:'task-1',expectedRevision:1,text:'只写报告不修复',replaces:true}]}, {},snapshot),/acceptance/);
 const result=normalizeRoutingResult({action:'plan',operations:[{action:'revise',targetId:'task-1',expectedRevision:1,text:'只写报告不修复',replaces:true,acceptance:['报告引用来源']}]}, {},snapshot);assert.equal(result.operations[0].replaces,true);
});

test('service timeout is identified without exposing provider details or blindly creating another in-flight call',async()=>{
 let calls=0;const classify=intentClassifier({llm:{complete:async()=>{calls++;return {ok:false,error:'llm.complete: 超时（约90s） api_key=DO_NOT_LEAK'};}}});
 await assert.rejects(classify({text:'转交发现'},{tasks:[],inputs:[]}),error=>{assert.match(error.message,/90 秒/);assert.doesNotMatch(error.message,/DO_NOT_LEAK|api_key/);return true;});assert.equal(calls,1);
});

test('historical title pages expose semantic candidates beyond literal synonyms, with bounded read-only pagination',()=>{
 const snapshot={tasks:[{id:'task-1',revision:2,status:'paused',objective:'身份认证超时与会话失效分析',nativeReference:{secret:'NEVER_EXPORT_HANDLE'}},...Array.from({length:160},(_,i)=>({id:`task-${i+2}`,revision:1,status:'paused',objective:`账目对照 ${i}`}))],inputs:[]};
 const first=JSON.parse(routingPrompt({text:'上回登不进去的工作',lookupTerms:['登录','登陆失败']},snapshot));assert.deepEqual(first.taskIndex[0],['task-1',2,'paused','身份认证超时与会话失效分析']);assert.ok(first.taskIndexPage.nextCursor>0);assert.ok(JSON.stringify(first).length<=8000);assert.doesNotMatch(JSON.stringify(first),/NEVER_EXPORT_HANDLE/);
 const next=JSON.parse(routingPrompt({text:'上回登不进去的工作',lookupTerms:['登录'],lookupCursor:first.taskIndexPage.nextCursor},snapshot));assert.notEqual(next.taskIndex[0][0],first.taskIndex[0][0]);assert.equal(snapshot.tasks[0].status,'paused');
});

test('repeating an explicit lookup page cannot spend the full page budget re-reading identical data',async()=>{
 let calls=0;const classify=intentClassifier({llm:{complete:async()=>{calls++;return {ok:true,text:'{"action":"lookup","queries":["登录"],"cursor":0}'};}}});const result=await classify({text:'继续旧调查'},{tasks:[{id:'task-1',revision:1,status:'paused',objective:'未知事项'}],inputs:[]});assert.equal(calls,2);assert.equal(result.action,'clarify');
});

test('named original clauses omitted by head/tail clipping are retrieved before the first model call',()=>{
 const source='前言'.repeat(1500)+'MID_POLICY_X：移动端必须在真实手机验证。api_key=NEVER_EXPORT '+'附录'.repeat(1500);const task={id:'task-1',revision:1,status:'paused',objective:'报告',sourceText:source};const prompt=routingPrompt({text:'报告中 MID_POLICY_X 的原要求是什么'},{tasks:[task],inputs:[]});const context=JSON.parse(prompt).taskCandidates[0].matchedOriginalContext;assert.equal(context.field,'sourceText');assert.match(context.text,/真实手机/);assert.equal(context.partial,true);assert.ok(context.offset>1000);assert.doesNotMatch(prompt,/NEVER_EXPORT/);assert.ok(prompt.length<=8000);assert.equal(task.sourceText,source);
});

test('a missing-history clarification performs one bounded semantic index read before asking the user to repeat it',async()=>{
 const tasks=[{id:'task-1',revision:1,status:'paused',objective:'身份认证超时调查'},...Array.from({length:160},(_,i)=>({id:`task-${i+2}`,revision:1,status:'paused',objective:`账目对照 ${i}`}))];let calls=0;const classify=intentClassifier({llm:{complete:async request=>{if(++calls===1)return {ok:true,text:'{"action":"clarify","text":"缺少旧任务标题"}'};assert.ok(JSON.parse(request.prompt).taskIndex.some(row=>row[0]==='task-1'));return {ok:true,text:'{"action":"resume","targetId":"task-1","expectedRevision":1}'};}}});const result=await classify({text:'上回那个登不进去的工作继续'},{tasks,inputs:[]});assert.equal(calls,2);assert.equal(result.operations[0].targetId,'task-1');assert.equal(tasks[0].status,'paused');
});

test('unknown browser conversation never inherits the legacy default focus',()=>{
 const prompt=JSON.parse(routingPrompt({text:'继续那个',conversationId:'new-browser'},{tasks:[{id:'task-1',revision:1,objective:'调查',status:'paused'}],inputs:[],focusByConversation:{default:{taskIds:['task-1']}}}));
 assert.deepEqual(prompt.persistedFocus,[]);
});

test('relationship context is allowlisted just like the task record, not blindly serialized',()=>{
 const prompt=routingPrompt({text:'根据登录调查写报告',conversationId:'a'},{tasks:[{id:'task-1',revision:1,objective:'登录调查',status:'verified',derivedFrom:{taskId:'task-2',revision:1,objective:'发现',handle:{token:'must-not-leak'},evidence:{executorReport:'private-secret'},secret:'sensitive-value'},dependencies:[{taskId:'task-2',revision:1,condition:'完成',token:'also-secret'}]}],inputs:[]});
 assert.doesNotMatch(prompt,/must-not-leak|private-secret|sensitive-value|also-secret/);
 assert.match(prompt,/task-2/);
});
