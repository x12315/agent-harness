import { open, realpath, stat } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";

/** Read only a native-announced transcript under configured native session roots and matching workspace. No session is changed. */
export function nativeSessionReader(roots) {
 return async ({file,cwd,streaming}) => {
  if(typeof file!=="string"||!file.endsWith(".jsonl"))return null;
  let actual,workspace,allowed=false;
  try{
   actual=await realpath(file);workspace=await realpath(cwd);
   for(const root of roots.filter(Boolean)){let base;try{base=await realpath(root);}catch{continue;}const path=relative(base,actual);if(path&&!path.startsWith('..')&&!isAbsolute(path))allowed=true;}
   if(!allowed)return null;
   const before=await stat(actual);if(!before.isFile())return null;
   const handle=await open(actual,"r");
   try{
    const metadata=await handle.stat();if(metadata.ino!==before.ino||metadata.dev!==before.dev)return null;
    const head=Buffer.alloc(4096);const first=await handle.read(head,0,head.length,0);
    const header=JSON.parse(head.subarray(0,first.bytesRead).toString('utf8').split('\n')[0]);
    if(header.type!=="session"||header.version!==3||await realpath(header.cwd)!==workspace)return null;
    const start=Math.max(0,metadata.size-524288),buffer=Buffer.alloc(Math.min(metadata.size,524288));
    const result=await handle.read(buffer,0,buffer.length,start);let lines=buffer.subarray(0,result.bytesRead).toString('utf8').split('\n');if(start)lines.shift();
    const entries=[];for(const line of lines){try{const entry=JSON.parse(line);if(entry.id)entries.push(entry);}catch{}}
    const indexed=new Map(entries.map(entry=>[entry.id,entry]));const branch=[];let entry=entries.at(-1);const seen=new Set();
    while(entry&&!seen.has(entry.id)){seen.add(entry.id);branch.unshift(entry);entry=indexed.get(entry.parentId);}
    const calls=new Map(),completed=new Set(),evidence=[];
    const text=(message)=>(typeof message.content==='string'?message.content:(message.content||[]).filter(part=>part.type==='text').map(part=>part.text).join('\n'));
    for(const entry of branch){const message=entry.message;if(!message)continue;
     if(message.role==='assistant')for(const part of Array.isArray(message.content)?message.content:[])if(part.type==='toolCall')calls.set(part.id,{id:part.id,tool:part.name,arguments:part.arguments,at:message.timestamp});
     if(message.role==='toolResult'){completed.add(message.toolCallId);const call=calls.get(message.toolCallId);evidence.push({tool:message.toolName,arguments:call?.arguments,startedAt:call?.at,finishedAt:message.timestamp,isError:message.isError===true,output:text(message).slice(-3000)});}
    }
    const pending=[...calls.values()].filter(call=>!completed.has(call.id)).at(-1);
    const command=pending?.arguments?.command||pending?.arguments?.path||pending?.arguments?.file_path||'';
    return {progress:pending&&streaming?{tool:pending.tool,summary:`正在执行 ${pending.tool}${command?`：${String(command).slice(0,300)}`:''}`}:{summary:streaming?'执行者正在分析或整理结果':'执行者本轮已停止'},evidence:evidence.slice(-12)};
   }finally{await handle.close();}
  }catch{return null;}
 };
}
