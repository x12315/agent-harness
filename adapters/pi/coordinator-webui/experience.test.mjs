import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {modelObject,routingPrompt} from './model-json.mjs';
import {nativeEvidence} from './native-evidence.mjs';
import {nativeSessionReader} from './native-session.mjs';
import {coverageGate} from './coverage.mjs';

test('routing tolerates fenced JSON and bounds long escaped input without dropping authoritative raw text',()=>{
 assert.deepEqual(modelObject('```json\n{"action":"question","text":"ok"}\n```'),{action:'question',text:'ok'});
 assert.throws(()=>modelObject('[]'));
 const input={text:'\\"'.repeat(8000)};
 const snapshot={inputs:Array.from({length:100},()=>({text:input.text,status:'question',answer:input.text})),tasks:Array.from({length:100},(_,n)=>({id:`task-${n}`,objective:input.text,status:'running',progress:{summary:input.text}}))};
 assert.ok(routingPrompt(input,snapshot).length<=8000);assert.equal(input.text.length,16000);
});

test('native coverage evidence keeps executor/tool evidence that precedes final verdict',async()=>{
 const messages=[{role:'user',content:"# Executor's summary this round\nCreated notes/status.txt\n# Executor's recent tool & command evidence (auto-collected)\n1. bash\nExact bytes: PASS\nYou may verify with read-only means"},{role:'assistant',content:[{type:'toolCall',id:'read1',name:'read',arguments:{path:'notes/status.txt'}}]},{role:'toolResult',toolCallId:'read1',toolName:'read',content:[{type:'text',text:'expected bytes\n'}]},{role:'assistant',content:[{type:'text',text:'{"verdict":"pass"}'}]}];
 const evidence=nativeEvidence(messages,{feedback:'Inspected exact bytes',round:1});
 assert.match(evidence.toolEvidence,/Exact bytes: PASS/);assert.equal(evidence.inspections[0].call.arguments.path,'notes/status.txt');
 const textOnly=nativeEvidence([{role:'user',content:"# Executor's summary this round\nA concise answer\nYou may verify with read-only means\n[goal-review]"}],{feedback:'pass',round:1});assert.equal(textOnly.executorReport,'A concise answer');
 let request;
 const gate=coverageGate({llm:{complete:async value=>{request=value;return {ok:true,text:JSON.stringify({complete:true,checked:[{requirement:'create notes/status.txt',evidence:'native tools and inspection'}],missing:[]})};}}});
 const result=await gate({id:'task-1',revision:2,sourceText:'create notes/status.txt',objective:'create notes/status.txt',amendments:[{source:'coverage-review',text:'Do not treat this as new scope'}]},evidence);
 assert.equal(result.status,'passed');assert.ok(request.prompt.length<=8000);assert.match(request.prompt,/Exact bytes: PASS/);assert.equal(JSON.parse(request.prompt).requirements,'create notes/status.txt');assert.equal(JSON.parse(request.prompt).nativeEvidence.coordinatorFacts.independentTaskCreated,true);
});

test('native progress reads only native-announced matching-workspace version3 transcripts and pairs tool calls',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-progress-'));
 try{
  const sessions=join(root,'sessions'),cwd=join(root,'workspace');await mkdir(sessions);await mkdir(cwd);
  const file=join(sessions,'owned.jsonl');
  const header={type:'session',version:3,id:'session',cwd};
  const call={type:'message',id:'call',parentId:null,message:{role:'assistant',timestamp:1,content:[{type:'toolCall',id:'tool-1',name:'bash',arguments:{command:'node scripts/slow-check.mjs'}}]}};
  await writeFile(file,[header,call].map(JSON.stringify).join('\n')+'\n');
  const read=nativeSessionReader([sessions]);const pending=await read({file,cwd,streaming:true});assert.match(pending.progress.summary,/node scripts\/slow-check.mjs/);assert.equal(pending.progress.tool,'bash');
  const result={type:'message',id:'result',parentId:'call',message:{role:'toolResult',toolCallId:'tool-1',toolName:'bash',timestamp:2,content:[{type:'text',text:'completed 45/45'}]}};
  await writeFile(file,[header,call,result].map(JSON.stringify).join('\n')+'\n');
  const done=await read({file,cwd,streaming:false});assert.equal(done.evidence[0].arguments.command,'node scripts/slow-check.mjs');assert.match(done.evidence[0].output,/45\/45/);
  assert.equal(await nativeSessionReader([cwd])({file,cwd,streaming:true}),null);
  assert.equal(await read({file,cwd:sessions,streaming:true}),null);
 }finally{await rm(root,{recursive:true,force:true});}
});
