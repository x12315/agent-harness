import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { statSync, existsSync } from 'node:fs';
assert.equal(await realpath(dirname(fileURLToPath(import.meta.url))), await realpath('/tmp/ahsb-push'), 'run only from sandbox guest input');
const runtime=join(homedir(),'.local/share/ahsb-runtime');
const require=createRequire(join(runtime,'node_modules/pi-web-ui/package.json'));
const pty=require('node-pty');
const modulePath=require.resolve('node-pty');
const helper=join(runtime,'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper');
console.log(JSON.stringify({runtime,execPath:process.execPath,cwd:process.cwd(),modulePath,helper,exists:existsSync(helper),mode:statSync(helper).mode.toString(8)}));
for (const cwd of [runtime,'/tmp']) {
 try {
  const result=await new Promise((resolve,reject)=>{const c=pty.spawn(process.execPath,['-e','console.log("probe-ok")'],{cwd,env:process.env});let output='';c.onData(s=>output+=s);c.onExit(x=>resolve({cwd,...x,output}));setTimeout(()=>{try{c.kill();}catch{}reject(Error('probe-timeout'));},5000).unref();});
  console.log(JSON.stringify(result));
 } catch(error) {console.log(JSON.stringify({cwd,error:error.message}));}
}
