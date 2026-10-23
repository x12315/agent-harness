#!/usr/bin/env node
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, open, symlink, realpath, stat, readdir, rename, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const operation = args[0] && !args[0].startsWith("--") ? args.shift() : "start";
const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index+1]; };
const root = resolve(option("--state-dir", join(homedir(), ".local/share/harness/coordinator")));
const stateFile = join(root, "launcher.json");
const json = async (file, fallback = null) => {try{return JSON.parse(await readFile(file,"utf8"));}catch(error){if(error.code==="ENOENT")return fallback;throw error;}};
const live = (pid) => {try{process.kill(pid,0);return true;}catch{return false;}};
const previous = await json(stateFile);
const port = Number(option("--port", previous?.port || 8793));
if(!Number.isInteger(port)||port<1024||port>65535) throw Error("Invalid unprivileged port");
const url = `http://127.0.0.1:${port}/plugins-api/pi-coordinator/experience`;
const nativeAgent = resolve(option("--native-agent-dir", join(homedir(), ".pi/agent")));
const agent = join(root,"agent"), data = join(root,"web"), sessions = join(root,"sessions");
const workspace = resolve(option("--workspace", previous?.workspace || join(root,"workspace")));
const packageRoot = resolve(option("--web-package",join(nativeAgent,"npm/node_modules/pi-web-ui")));

async function ownsServer() {
 if(!previous?.pid || previous.source!==source || !live(previous.pid))return false;
 try{const {stdout}=await promisify(execFile)("ps",["-p",String(previous.pid),"-o","command="]);return stdout.includes("/pi-web-ui.mjs")&&stdout.includes(`--data-dir ${data}`);}catch{return false;}
}
async function status() {
 if(!await ownsServer())return false;
 try{const result=await fetch(`http://127.0.0.1:${previous.port}/api/health`,{signal:AbortSignal.timeout(2000)});return result.ok;}catch{return false;}
}
async function stop() {
 if(!previous?.pid || !live(previous.pid))return;
 if(!await ownsServer())throw Error("Refusing to stop a process not proven to be this coordinator server");
 process.kill(previous.pid,"SIGTERM");
 const end=Date.now()+12000;while(live(previous.pid)&&Date.now()<end)await delay(100);
 if(live(previous.pid))throw Error("Server stop unconfirmed; inspect private log before retrying");
}
if(operation==="shortcut") {
 const target=join(homedir(),"Desktop/任务协调.command");
 const quote=value=>`'${value.replaceAll("'","'\\''")}'`;
 const content=`#!/bin/bash\nexec ${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} start --state-dir ${quote(root)}\n`;
 try{await writeFile(target,content,{flag:"wx",mode:0o700});}catch(error){if(error.code!=="EEXIST")throw error;if(await readFile(target,"utf8")!==content)throw Error("Existing Desktop shortcut differs; it was not overwritten");}
 await chmod(target,0o700);console.log(target);process.exit(0);
}
if(operation==="status") {console.log(JSON.stringify({running:await status(),url,workspace,stateDir:root,browserAuthenticationRequired:previous?.authRequired===true}));process.exit(0);}
if(operation==="stop") {await stop();console.log("任务协调已停止；任务和会话仍保留。");process.exit(0);}
if(operation==="restart")await stop();
else if(operation!=="start")throw Error("Usage: node scripts/pi-coordinator.mjs [start|stop|restart|status|shortcut] [--workspace PATH] [--port PORT] [--no-open]");
if(await status()) {
 if(previous.workspace!==workspace||previous.source!==source)throw Error("An existing coordinator has a different workspace/source; use restart explicitly");
 console.log(url);
 if(previous.authRequired || process.env.PI_WEB_TOKEN)console.log("后台运行正常；浏览器仍需通过原生 PI_WEB_TOKEN 认证。没有打印、转交访问口令或自动打开未认证页面。");
 else if(!args.includes("--no-open"))spawn("open",[url],{stdio:"ignore",detached:true}).unref();process.exit(0);
}
await mkdir(root,{recursive:true,mode:0o700});
for(const folder of [agent,data,sessions])await mkdir(folder,{recursive:true,mode:0o700});
const observerRoot = join(root,"observer");
const ownWorkspace = workspace===join(root,"workspace") || (args.includes("--example") && workspace.startsWith(root+"/"));
if(ownWorkspace) {
 await mkdir(workspace,{recursive:true,mode:0o700});
 const seeds={
  "AGENTS.md":"# Workspace\n\nThis is an independent, dependency-free Node.js example workspace, not the Harness Engine or Catalog repository. For changes here run node --test; do not run unrelated Harness control-plane/doctor checks. Keep user constraints and existing files. This directory may not be a Git repository: use file inspection and Node tests rather than assuming git status/diff is available.\n",
  "README.md":"# 任务协调体验工作区\n\n这里是独立可写项目，不影响日常仓库。pagination.mjs 有一个待排查的分页问题；可让 AI 调查、补测试和修复。\n\n试试直接说：调查分页问题，保留导出接口，补回归测试。先运行 node scripts/slow-check.mjs，再检查源码。\n\n长检查期间可以自由提问、补充边界、暂停、继续或取消。也可使用启动器 --workspace 指定自己的受信任项目。\n",
  "package.json":JSON.stringify({name:"coordination-workspace",private:true,type:"module",scripts:{test:"node --test"}},null,2)+"\n",
  "pagination.mjs":"export function paginate(items, page = 1, pageSize = 10) {\n  return items.slice(page * pageSize, (page + 1) * pageSize);\n}\n",
  "pagination.test.mjs":"import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {paginate} from './pagination.mjs';\ntest('first page starts with the first item',()=>assert.deepEqual(paginate([1,2,3,4],1,2),[1,2]));\n",
  "scripts/slow-check.mjs":"import {writeFile} from 'node:fs/promises';\nimport {setTimeout as delay} from 'node:timers/promises';\nawait writeFile(new URL('../.long-check.pid',import.meta.url),String(process.pid));\nconsole.log('长检查已开始，可以继续对话或暂停任务。');\nfor(let i=1;i<=45;i++){await delay(1000);if(i%5===0)console.log(`检查进度 ${i}/45`);}\nconsole.log('长检查结束，继续检查分页边界。');\n",
 };
 for(const [name,text] of Object.entries(seeds)) {const file=join(workspace,name);await mkdir(dirname(file),{recursive:true,mode:0o700});try{await writeFile(file,text,{flag:"wx",mode:0o600});}catch(error){if(error.code!=="EEXIST")throw error;}}
}
await realpath(workspace);
const defaults=await json(join(nativeAgent,"settings.json"),{});
const privateDefaults=await json(join(agent,"settings.json"),{});
const savedModel=privateDefaults.defaultProvider&&privateDefaults.defaultModel?`${privateDefaults.defaultProvider}/${privateDefaults.defaultModel}`:undefined;
const model=option("--model",savedModel || previous?.model || `${defaults.defaultProvider||"openai-codex"}/${defaults.defaultModel||"gpt-6.1-sol"}`);
if(!/^[^\s/]+\/.+$/.test(model))throw Error("Model must be provider/model");
await stat(join(packageRoot,"bin/pi-web-ui.mjs"));
if((await json(join(packageRoot,"package.json")))?.version!=="0.100.0")throw Error("This coordinator requires the tested pi-web-ui 0.100.0; no installed package was changed");
const sdkDir=join(packageRoot,"../@earendil-works/pi-coding-agent");
if((await json(join(sdkDir,"package.json")))?.version!=="1.1.0")throw Error("This coordinator requires the aligned Pi SDK 1.1.0; no installed package was changed");
await stat(join(nativeAgent,"auth.json"));
for(const name of ["auth.json","models.json"]) {
 const target=join(nativeAgent,name);try{await stat(target);}catch(error){if(error.code==="ENOENT"&&name==="models.json")continue;throw error;}
 try{await symlink(target,join(agent,name));}catch(error){if(error.code!=="EEXIST")throw error;if(await realpath(join(agent,name))!==await realpath(target))throw Error(`Independent native ${name} already points elsewhere`);}
}
await writeFile(join(agent,"settings.json"),JSON.stringify({...privateDefaults,defaultProvider:model.split('/')[0],defaultModel:model.slice(model.indexOf('/')+1),defaultThinkingLevel:privateDefaults.defaultThinkingLevel??"low",packages:privateDefaults.packages??[],skills:privateDefaults.skills??[],noExtensions:privateDefaults.noExtensions??true}),{mode:0o600});
await mkdir(join(data,"plugin-overrides"),{recursive:true,mode:0o700});
await writeFile(join(data,"plugin-overrides/pi-coordinator.json"),JSON.stringify({settings:{allowExecution:true,allowObserverControl:true,endpoint:`ws://127.0.0.1:${port}/ws`,model}}),{mode:0o600});
await writeFile(join(data,"plugin-overrides/pi-observer.json"),JSON.stringify({settings:{allowControl:true}}),{mode:0o600});
await mkdir(observerRoot,{recursive:true,mode:0o700});
await new Promise((accept,reject)=>{const probe=createServer();probe.once("error",()=>reject(Error("Selected port is occupied; daily servers will not be stopped")));probe.listen(port,"127.0.0.1",()=>probe.close(accept));});
const cli=join(packageRoot,"bin/pi-web-ui.mjs");
const run=(arguments_)=>new Promise((accept,reject)=>{const child=spawn(process.execPath,[cli,...arguments_],{env:{...process.env,PI_WEB_UI_PACKAGE:packageRoot},stdio:["ignore","ignore","pipe"]});let error="";child.stderr.on("data",chunk=>{error+=chunk;});child.once("exit",code=>code===0?accept():reject(Error("Native plugin install failed; inspect runtime installation")));child.once("error",reject);});
const hashes=async(directory)=>{const files=await readdir(directory,{recursive:true,withFileTypes:true});const entries=[];for(const file of files){if(!file.isFile())continue;const absolute=join(file.parentPath,file.name),relative=absolute.slice(directory.length+1);if(relative.startsWith('state/')||relative.startsWith('client/vendor/')||relative.split('/').includes('node_modules'))continue;entries.push([relative,createHash('sha256').update(await readFile(absolute)).digest('hex')]);}return Object.fromEntries(entries.sort(([a],[b])=>a.localeCompare(b)));};
/** Install or update one owned plugin without overwriting unknown content or its saved settings. */
async function ensurePlugin({name,sourceDirectory,build}) {
 const directory=join(data,"plugins",name),pinPath=join(root,`installed-${name}.json`);
 const desired=await hashes(sourceDirectory);
 const pin=await json(pinPath) ?? (name==="pi-coordinator"?await json(join(root,"installed-source.json")):null);
 let retainedStorage,exists=true;
 try{await stat(directory);}catch(error){if(error.code!=="ENOENT")throw error;exists=false;}
 if(exists) {
  if(pin?.source!==sourceDirectory)throw Error(`Existing ${name} is not owned by this launcher; choose another state directory`);
  for(const [file,hash] of Object.entries(pin.files)){let actual;try{actual=createHash('sha256').update(await readFile(join(directory,file))).digest('hex');}catch{throw Error(`Installed ${name} changed; preserve and inspect it before updating`);}if(actual!==hash)throw Error(`Installed ${name} changed; preserve and inspect it before updating`);}
  if(JSON.stringify(desired)!==JSON.stringify(pin.files)){
   try{retainedStorage=await readFile(join(directory,'storage.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
   await rename(directory,join(root,`plugin-backup-${name}-${Date.now()}`));exists=false;
  }
 }
 if(!exists){
  await run(["install",sourceDirectory,"--name",name,"--data-dir",data,...(build?["--build"]:[])]);
  if(retainedStorage)await writeFile(join(directory,"storage.json"),retainedStorage,{flag:"wx",mode:0o600});
  await writeFile(pinPath,JSON.stringify({source:sourceDirectory,files:desired}),{mode:0o600});
 }
}
await ensurePlugin({name:"pi-coordinator",sourceDirectory:join(source,"adapters/pi/coordinator-webui"),build:true});
await ensurePlugin({name:"pi-observer",sourceDirectory:join(source,"adapters/pi/observer-webui"),build:false});
const log=await open(join(root,"server.log"),"a",0o600);
const env={...process.env,PI_CODING_AGENT_DIR:agent,PI_CODING_AGENT_SESSION_DIR:sessions,PI_WEB_PLUGIN_CATALOG_URL:"off",PI_WEB_SDK:"global",PI_WEB_SDK_DIR:sdkDir,PI_COORDINATOR_MODEL:model,PI_OBSERVER_DIR:observerRoot,LANG:"zh_CN.UTF-8"};
const child=spawn(process.execPath,[cli,"--no-browser","--host","127.0.0.1","--port",String(port),"--cwd",workspace,"--agent-dir",agent,"--data-dir",data],{env,stdio:["ignore",log.fd,log.fd],detached:true});
await log.close();child.unref();
await writeFile(stateFile,JSON.stringify({pid:child.pid,source,port,workspace,model,authRequired:Boolean(env.PI_WEB_TOKEN),startedAt:new Date().toISOString()},null,2),{mode:0o600});
const end=Date.now()+60000;let socket;
try{
 while(Date.now()<end){if(!live(child.pid))throw Error("Coordinator server exited; inspect private server.log");try{const response=await fetch(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(1000)});if(response.ok)break;}catch{}await delay(150);}
 await new Promise((accept,reject)=>{
  const timer=setTimeout(()=>reject(Error("Native plugin startup is not confirmed; inspect private server.log")),Math.max(1000,end-Date.now()));
  const endpoint=new URL(`ws://127.0.0.1:${port}/ws`);if(env.PI_WEB_TOKEN)endpoint.searchParams.set('token',env.PI_WEB_TOKEN);
  socket=new WebSocket(endpoint.href);
  socket.addEventListener("open",()=>socket.send(JSON.stringify({type:"hello",clientId:crypto.randomUUID(),locale:"zh"})));
  socket.addEventListener("message",({data})=>{let message;try{message=JSON.parse(String(data));}catch{return;}if(message.type==="plugins"&&["pi-coordinator","pi-observer"].every(id=>message.plugins?.some(plugin=>plugin.id===id&&plugin.active))){clearTimeout(timer);accept();}});
  socket.addEventListener("error",()=>{clearTimeout(timer);reject(Error("Startup connection failed"));});
 });
 socket.close();const response=await fetch(url,{signal:AbortSignal.timeout(3000),...(env.PI_WEB_TOKEN?{headers:{Authorization:`Bearer ${env.PI_WEB_TOKEN}`}}:{})});if(!response.ok)throw Error("User-facing page is unavailable");
 console.log(`${env.PI_WEB_TOKEN?'任务协调后端已就绪；浏览器需完成原生访问口令认证':'任务协调已就绪'}\n${url}\n工作区：${workspace}\n模型：${model}\n原生日常服务保持不变。`);
 if(env.PI_WEB_TOKEN)console.log("启动探针的认证不代表浏览器已认证；请通过原生访问口令方式进入。口令不会写入快捷方式、日志或进程参数。");
 else if(!args.includes("--no-open"))spawn("open",[url],{stdio:"ignore",detached:true}).unref();
}catch(error){socket?.close();console.error(error.message);console.error(`诊断日志：${join(root,"server.log")}`);process.exitCode=1;}
