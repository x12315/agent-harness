/** Guest-only Chromium QA with a bounded loopback model fixture, not a model-quality test. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { buildClient } from "../../adapters/pi/coordinator-webui/build-client.mjs";

assert.equal(process.platform, "darwin", "macOS guest required");
assert.ok(process.env.AHSB_RUNTIME_DIR, "sandbox runtime required; never execute on host");
const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
assert.equal(await realpath(project), await realpath("/tmp/ahsb-push"), "sandbox pushed source only");
const runtime = process.env.AHSB_RUNTIME_DIR;
const modules = join(runtime, "node_modules");
const browserBin = join(modules, "agent-browser/bin/agent-browser-darwin-arm64");
let chrome;
const installedHome = process.env.HOME;
const webDir = join(modules, "pi-web-ui"), piDir = join(modules, "@earendil-works/pi-coding-agent");
const root = await mkdtemp("/tmp/co-browser-");
const home = join(root, "home"), agent = join(home, ".pi/agent"), cwd = join(root, "workspace"), data = join(root, "data");
const artifacts = "/tmp/ah-artifacts";
for (const dir of [agent, cwd, data, artifacts]) await mkdir(dir, { recursive: true, mode: 0o700 });
const startedAt = Date.now(), budgetMs = 105000;
const receipt = { schemaVersion: 1, ok: false, result: "FAIL", platform: process.platform, fixture: "guest-loopback-deterministic", modelQualityTest: false, budgetMs, checks: {}, issues: [], observations: [], sources: {}, screenshots: [], mock: { requests: 0, classifications: [], executorCalls: 0, reviewCalls: 0, coverageCalls: 0, externalAttempts: [] } };
const authState = join(root, "auth-entry-check");
const transcript = [], artifactNames = new Set(), pendingCommands = new Set(), held = new Set();
let child, childExit, serverLog = "", provider, fatal, browserStarted = false, startupSocket;
const stop = new AbortController();
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const save = async (name, content) => { await writeFile(join(artifacts, name), content, { mode: 0o600 }); artifactNames.add(name); };
const check = (name, condition, detail) => {
 receipt.checks[name] = !!condition;
 if (!condition) { receipt.issues.push({ check: name, detail }); console.error(`BROWSER_UI_FAILURE ${JSON.stringify({ check: name, detail })}`); }
};
const wait = async (predicate, label, ms = 7000) => {
 const end = Date.now() + ms;
 while (Date.now() < end) {
  stop.signal.throwIfAborted();
  if (fatal) throw fatal;
  if (childExit) throw Error(`WebUI exited before ${label}: ${JSON.stringify(childExit)}`);
  const value = await predicate(); if (value) return value;
  await delay(80);
 }
 throw Error(`Timed out: ${label}`);
};
async function command(args, timeout = 7000, { raw = false, allowFailure = false } = {}) {
 stop.signal.throwIfAborted();
 const begin = Date.now();
 const proc = spawn(browserBin, args, { cwd, env: browserEnv, stdio: ["ignore", "pipe", "pipe"] });
 pendingCommands.add(proc);
 let stdout = "", stderr = "";
 proc.stdout.on("data", (part) => { stdout += part; if (stdout.length > 1500000) proc.kill("SIGKILL"); });
 proc.stderr.on("data", (part) => { stderr = (stderr + part).slice(-30000); });
 const timer = setTimeout(() => proc.kill("SIGKILL"), timeout);
 const code = await new Promise((done, reject) => { proc.on("error", reject); proc.on("close", done); }).finally(() => { clearTimeout(timer); pendingCommands.delete(proc); });
 const record = { command: args[0], args: args[0] === "eval" ? ["<DOM expression>"] : args.slice(1), code, elapsedMs: Date.now() - begin, stdout, stderr };
 transcript.push(record);
 if (code !== 0 && !allowFailure) throw Error(`agent-browser ${args[0]} failed (${code}): ${stderr || stdout}`);
 if (raw || code !== 0) return stdout;
 const result = JSON.parse(stdout);
 if (result.success === false && !allowFailure) throw Error(`agent-browser ${args[0]}: ${JSON.stringify(result)}`);
 return result.data;
}
const browserEnv = { PATH: `${join(runtime, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: root, LANG: "en_US.UTF-8", AGENT_BROWSER_SESSION: `qa-${process.pid}`, AGENT_BROWSER_SOCKET_DIR: join(root, "sockets"), AGENT_BROWSER_DEFAULT_TIMEOUT: "4000", AGENT_BROWSER_IDLE_TIMEOUT_MS: "120000", AGENT_BROWSER_ALLOWED_DOMAINS: "127.0.0.1,localhost" };
const browser = (...args) => command(["--json", ...args]);
const evaluate = async (expression) => {
 const data = await browser("eval", "-b", Buffer.from(expression).toString("base64"));
 return data?.result;
};
const waitDom = async (expression, label, ms) => wait(() => evaluate(expression), label, ms);
async function screenshot(name) {
 await browser("screenshot", join(artifacts, name));
 const image = await readFile(join(artifacts, name));
 assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
 artifactNames.add(name); receipt.screenshots.push({ name, sha256: sha(image), bytes: image.length, width: image.readUInt32BE(16), height: image.readUInt32BE(20) });
 console.error(`BROWSER_SCREENSHOT ${name}`);
}
const domExpression = `(() => {
 const rect = selector => { const el = document.querySelector(selector); if (!el) return null; const r = el.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom, scrollHeight:el.scrollHeight, clientHeight:el.clientHeight, overflowY:getComputedStyle(el).overflowY }; };
 return { url:location.href, viewport:{width:innerWidth,height:innerHeight}, pageWidth:document.documentElement.scrollWidth, pageHeight:document.documentElement.scrollHeight, title:document.title, text:document.body.innerText, root:rect('.co-workspace'), chat:rect('.co-chat'), conversation:rect('.co-conversation'), sidebar:rect('.co-sidebar'), tasks:rect('.co-task-list'), composer:rect('.co-composer'), input:rect('textarea'), send:rect('.co-send'), controls:[...document.querySelectorAll('[data-action]')].map(el=>({action:el.dataset.action,disabled:el.disabled,label:el.getAttribute('aria-label')})), requests:[...document.querySelectorAll('.co-message-user .co-text')].map(el=>el.textContent), taskStates:[...document.querySelectorAll('.co-task')].map(el=>({id:el.dataset.taskId,status:el.querySelector('.co-status')?.textContent,objective:el.querySelector('h3')?.textContent})), styles:[...document.styleSheets].map(sheet=>sheet.href), clientId:localStorage.getItem('pi-coordinator-experience-client') };
})()`;
async function captureDom(name) {
 const dom = await evaluate(domExpression); assert.ok(dom?.root, "real rendered coordinator DOM required");
 await save(name, JSON.stringify(dom, null, 2)); return dom;
}
function checkLayout(dom, mode) {
 const { chat, sidebar, composer, input, send, viewport, tasks } = dom;
 check(`${mode}NoHorizontalOverflow`, dom.pageWidth <= viewport.width + 1, dom);
 check(`${mode}ComposerVisible`, composer.y >= 0 && composer.bottom <= viewport.height + 1 && input.width > 100 && send.width >= 44, { composer, input, send, viewport });
 check(`${mode}TaskScrollRegion`, tasks.height >= 60 && ["auto", "scroll"].includes(tasks.overflowY), tasks);
 check(`${mode}Layout`, mode === "desktop" ? sidebar.x >= chat.right - 1 && Math.abs(sidebar.y - chat.y) < 2 : sidebar.y >= chat.bottom - 1 && Math.abs(sidebar.x - chat.x) < 2, { chat, sidebar });
}
const question = "BROWSER_QUESTION：后台执行时我还能继续提问吗？";
const questionEnter = "BROWSER_ENTER：请确认这条由 Enter 发送的问题。";
const questionHeld = "BROWSER_HELD_QUESTION：后台任务运行时，请确认仍能回答。";
const completedTask = "BROWSER_DONE：检查隔离工作区并提供逐项证据，不修改生产部署。";
const heldTask = "BROWSER_HOLD：持续检查隔离工作区，等待暂停、继续或取消；保留完整原始要求。";
const lastUserText = (messages) => { const value = messages.filter(message => message.role === "user").at(-1)?.content; return typeof value === "string" ? value : (value ?? []).map(part => part.text ?? "").join("\n"); };
const respond = (res, text) => {
 if (res.destroyed) return;
 for (const [delta, finish_reason] of [[{ role: "assistant", content: text }, null], [{}, "stop"]]) res.write(`data: ${JSON.stringify({ id: "browser-fixture", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
 res.end("data: [DONE]\n\n");
};
async function main() {
 receipt.pi = (await json(join(piDir, "package.json"))).version;
 const webPackage = await json(join(webDir, "package.json")); receipt.webui = webPackage.version;
 receipt.agentBrowser = (await json(join(modules, "agent-browser/package.json"))).version;
 const pluginSource = join(project, "adapters/pi/coordinator-webui");
 const entries = await readdir(pluginSource, { recursive: true, withFileTypes: true });
 const sourcePaths = ["scripts/pi-coordinator.mjs", "scripts/tests/coordinator-browser-guest.mjs", ...entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath ?? entry.path, entry.name).slice(project.length + 1))].sort();
 for (const file of sourcePaths) receipt.sources[file] = sha(await readFile(join(project, file)));
 await command(["skills", "get", "core"], 5000, { raw: true });
 await save("agent-browser-core.md", transcript.at(-1).stdout);
 const chromeCandidates = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"];
 for (const cache of [join(installedHome, ".agent-browser/browsers"), join(installedHome, ".cache/agent-browser"), join(installedHome, ".cache/ms-playwright"), join(installedHome, "Library/Caches/ms-playwright")]) {
  try {
   const files = await readdir(cache, { recursive: true, withFileTypes: true });
   chromeCandidates.push(...files.filter(file => file.isFile() && ["Google Chrome for Testing", "Chromium", "chrome-headless-shell"].includes(file.name)).map(file => join(file.parentPath ?? file.path, file.name)));
  } catch (error) { if (error.code !== "ENOENT") throw error; }
 }
 for (const candidate of chromeCandidates) { try { await access(candidate); chrome = candidate; break; } catch {} }
 receipt.browserRuntime = { binary: browserBin, chromeCandidates, chrome, socketDir: browserEnv.AGENT_BROWSER_SOCKET_DIR };
 await save("browser-runtime.json", JSON.stringify(receipt.browserRuntime, null, 2));
 if (!chrome) {
  const isolatedHome = browserEnv.HOME;
  try { browserEnv.HOME = installedHome; await command(["doctor", "--offline", "--quick"], 5000, { raw: true, allowFailure: true }); await save("installed-browser-doctor.log", transcript.at(-1).stdout + transcript.at(-1).stderr); }
  finally { browserEnv.HOME = isolatedHome; }
 }
 assert.ok(chrome, "prepared guest Chrome missing; inspect browser-runtime.json and installed-browser-doctor.log, do not download in a test");
 browserEnv.AGENT_BROWSER_EXECUTABLE_PATH = chrome;
 provider = createServer((req, res) => {
  let body = "";
  req.on("data", chunk => { body += chunk; if (body.length > 2000000) req.destroy(Error("fixture request budget")); });
  req.on("end", () => {
   try {
    assert.equal(req.url, "/v1/chat/completions"); assert.ok(++receipt.mock.requests <= 45, "bounded local model calls");
    const request = JSON.parse(body); assert.equal(request.model, "local"); assert.equal(request.stream, true);
    const prompt = lastUserText(request.messages);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    if (body.includes("You route a user's free-form requests")) {
     const start = prompt.indexOf('{"userMessage":'); assert.ok(start >= 0, "classifier JSON envelope required");
     const input = JSON.parse(prompt.slice(start)), text = input.userMessage;
     let intent;
     if (/^请(?:暂停|继续|取消)任务/.test(text)) {
      const task = input.tasks.find(task => text.includes(`任务 ${task.id}`)); assert.ok(task, "control targets actual task ID");
      intent = { action: text.startsWith("请暂停") ? "pause" : text.startsWith("请继续") ? "resume" : "cancel", text, targetId: task.id };
     } else if ([completedTask, heldTask].includes(text)) intent = { action: "task", text };
     else { assert.ok([question, questionEnter, questionHeld].includes(text)); intent = { action: "question", text, answer: `BROWSER_ANSWER：可以继续提问。当前保留 ${input.tasks.length} 个任务；此回答仅来自确定性测试夹具。\n\n**组件复用验证**\n\n\`\`\`js\nconsole.log('safe');\n\`\`\`\n\n<script>window.unsafeMarkdownExecuted=true</script>\n\n[危险链接](javascript:alert(1))\n\n![不自动加载远端图片](https://invalid.example/image.png)` }; }
     receipt.mock.classifications.push({ text, action: intent.action, targetId: intent.targetId });
     respond(res, JSON.stringify(intent));
    } else if (body.includes("Check WHOLE-OBJECTIVE COVERAGE")) {
     receipt.mock.coverageCalls++;
     respond(res, JSON.stringify({ complete: true, checked: [{ requirement: completedTask, evidence: "BROWSER_EVIDENCE：隔离执行和独立检查均已通过（本地确定性夹具）。" }], missing: [] }));
    } else if (/^(?:你是严格、独立的验收者|You are a strict, independent acceptor)/.test(prompt)) {
     receipt.mock.reviewCalls++; respond(res, JSON.stringify({ verdict: "pass", feedback: "BROWSER_REVIEW：隔离夹具检查通过。" }));
    } else if (/^(?:\[Goal · round |【目标 · 第)/.test(prompt)) {
     receipt.mock.executorCalls++;
     assert.ok(prompt.includes("BROWSER_DONE") || prompt.includes("BROWSER_HOLD"), "only known fixture objectives execute");
     if (prompt.includes("BROWSER_HOLD")) { res.write(": bounded held fixture executor\n\n"); held.add(res); res.on("close", () => held.delete(res)); }
     else respond(res, "BROWSER_EXECUTION：已检查隔离工作区，无生产部署变更。确定性协议证据，不代表真实模型能力。");
    } else {
     assert.ok(/Review round|第 .*轮审查|Goal achieved and passed review|目标已达成并通过审查/.test(prompt), `unexpected native prompt: ${prompt.slice(0, 1000)}`);
     respond(res, "Fixture native continuation acknowledged.");
    }
   } catch (error) { fatal = error; res.destroy(); console.error(`BROWSER_FIXTURE_FAILURE ${error.message}`); }
  });
 });
 await new Promise(done => provider.listen(0, "127.0.0.1", done));
 const model = { id: "local", name: "Guest browser deterministic fixture", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
 await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { "fixture-local": { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: "openai-completions", apiKey: "local-fixture-not-a-secret", models: [model] } } }), { mode: 0o600 });
 await writeFile(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture-local", defaultModel: "local", defaultThinkingLevel: "off", compaction: { enabled: false }, packages: [], extensions: [], skills: [] }), { mode: 0o600 });
 const guard = join(root, "loopback-only.mjs");
 await writeFile(guard, `import net from 'node:net';import {appendFileSync} from 'node:fs';const connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){const first=Array.isArray(args[0])?args[0][0]:args[0];const host=typeof first==='object'?first.host:(typeof args[1]==='string'?args[1]:'localhost');if(host&&!['127.0.0.1','localhost','::1'].includes(host)){appendFileSync(process.env.FIXTURE_NETWORK_LOG,JSON.stringify({host})+'\\n');throw Error('fixture denied non-loopback network');}return connect.apply(this,args);};\n`, { mode: 0o600 });
 const probe = createServer(); await new Promise(done => probe.listen(0, "127.0.0.1", done));
 const port = probe.address().port; await new Promise(done => probe.close(done));
 assert.notEqual(port, 8793, "never use production port");
 const pluginDir = join(data, "plugins/pi-coordinator");
 await cp(pluginSource, pluginDir, { recursive: true, errorOnExist: true, force: false });
  receipt.uiComponents = await buildClient({webPackage:webDir,pluginDirectory:pluginDir});
 await mkdir(join(data, "plugin-overrides"), { recursive: true });
 await writeFile(join(data, "plugin-overrides/pi-coordinator.json"), JSON.stringify({ settings: { endpoint: `ws://127.0.0.1:${port}/ws`, model: "fixture-local/local", allowExecution: true } }));
 const env = { ...browserEnv, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_WEB_PLUGIN_CATALOG_URL: "off", PI_WEB_HOST: "127.0.0.1", PI_WEB_PORT: String(port), PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: data, PI_WEB_SDK_DIR: piDir, PI_WEB_SDK: "global", NO_PROXY: "127.0.0.1,localhost", NODE_OPTIONS: `--import=${guard}`, FIXTURE_NETWORK_LOG: join(root, "network.jsonl") };
 const bin = typeof webPackage.bin === "string" ? webPackage.bin : webPackage.bin["pi-web-ui"];
 child = spawn(process.execPath, [join(webDir, bin), "--no-browser", "--host", "127.0.0.1", "--port", String(port), "--cwd", cwd, "--data-dir", data], { env, cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
 child.on("error", error => { fatal = error; }); child.on("exit", (code, signal) => { childExit = { code, signal }; });
 for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { serverLog = (serverLog + chunk).slice(-100000); });
 const origin = `http://127.0.0.1:${port}`;
 await wait(async () => { try { const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(700) }); return response.ok && await response.json(); } catch { return false; } }, "isolated WebUI health", 15000);
 let pluginReady = false;
 startupSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
 startupSocket.addEventListener("open", () => startupSocket.send(JSON.stringify({ type: "hello", clientId: "11111111-2222-4333-8444-555555555555", locale: "zh" })));
 startupSocket.addEventListener("message", ({ data }) => { try { const message = JSON.parse(String(data)); if (message.type === "plugins" && message.plugins?.some(plugin => plugin.id === "pi-coordinator" && plugin.active)) pluginReady = true; } catch {} });
 startupSocket.addEventListener("error", () => { fatal = Error("guest native plugin startup WebSocket failed"); });
 await wait(() => pluginReady, "native plugin activation (same handshake as launcher)", 20000);
 startupSocket.close();
 browserStarted = true;
 await command(["--json", "--executable-path", chrome, "--allowed-domains", "127.0.0.1,localhost", "open", `${origin}/plugins-api/pi-coordinator/experience`], 15000);
 await waitDom("!!document.querySelector('.co-connection')?.textContent.startsWith('已更新')", "standalone plugin connection");
 const websocketGlobals = await evaluate("({ open:WebSocket.OPEN, connecting:WebSocket.CONNECTING, constructor:WebSocket.toString() })");
 await save("browser-websocket-globals.json", JSON.stringify(websocketGlobals, null, 2));
 if (websocketGlobals.open !== 1) {
  receipt.browserRuntime.allowlistCompatibility = "agent-browser allowlist replaced WebSocket without OPEN constant; use isolated guest browser without its JS wrapper";
  console.error(`BROWSER_HARNESS_LIMITATION ${receipt.browserRuntime.allowlistCompatibility}`);
  await browser("close");
  delete browserEnv.AGENT_BROWSER_ALLOWED_DOMAINS;
  browserEnv.AGENT_BROWSER_SESSION = `qb-${process.pid}`;
  await command(["--json", "--executable-path", chrome, "open", `${origin}/plugins-api/pi-coordinator/experience`], 15000);
  await waitDom("!!document.querySelector('.co-connection')?.textContent.startsWith('已更新')", "standalone plugin connection without broken browser wrapper");
 }
 await browser("set", "viewport", "1440", "1000");
 await screenshot("desktop-initial.png");
 check("actualPluginActivated", serverLog.includes("[plugin:pi-coordinator] activated"), serverLog.slice(-1000));
 check("sendInitiallyDisabled", await evaluate("document.querySelector('.co-send').disabled"), "empty composer must not submit");
 const initial = await captureDom("desktop-initial-dom.json"); checkLayout(initial, "desktop");
 await browser("snapshot", "-i"); await save("desktop-initial-snapshot.json", JSON.stringify(transcript.at(-1)));
 await browser("fill", "textarea[aria-label='你的需求或补充']", question);
 check("sendEnabledAfterTyping", await evaluate("!document.querySelector('.co-send').disabled"), "typing should enable send");
 await browser("click", ".co-send");
 await waitDom("document.querySelector('.co-message-assistant')?.textContent.includes('BROWSER_ANSWER')", "actual question response");
 check("sendClearsComposer", await evaluate("document.querySelector('textarea').value === ''"), "accepted send should clear input");
 await screenshot("desktop-question.png");
 check("matureMarkdownSafeRendering",await evaluate("document.querySelector('.co-markdown strong')?.textContent === '组件复用验证' && document.querySelector('.co-markdown pre code')?.textContent.includes('console.log') && !!document.querySelector('.co-markdown [aria-label=复制代码]') && !window.unsafeMarkdownExecuted && !document.querySelector('.co-markdown script,.co-markdown img,.co-markdown a[href^=\\\"javascript:\\\"]')"),"Marked grammar must render code/bold without executing raw HTML, remote images or dangerous URLs");
  const beforeReload = await captureDom("desktop-question-dom.json");
 if (beforeReload.root.height < beforeReload.viewport.height - 100) receipt.observations.push({ code: "DESKTOP_UNUSED_HEIGHT", severity: "visual", evidence: "desktop-question-dom.json", detail: `Workspace occupies ${Math.round(beforeReload.root.height)}px of ${beforeReload.viewport.height}px; composer moves as content grows instead of staying near viewport bottom.` });
 await browser("reload");
 await waitDom("document.querySelector('.co-message-assistant')?.textContent.includes('BROWSER_ANSWER')", "retained answer after reload");
 const reloaded = await captureDom("desktop-reload-dom.json");
 check("retainedQuestionAfterReload", reloaded.requests.filter(text => text === question).length === 1 && reloaded.clientId === beforeReload.clientId && receipt.mock.classifications.filter(item => item.text === question).length === 1, { requests: reloaded.requests, clientId: reloaded.clientId });
 await screenshot("desktop-reload.png");
 await browser("fill", "textarea", questionEnter); await browser("press", "Shift+Enter");
 check("shiftEnterInsertsNewline", await evaluate("document.querySelector('textarea').value.endsWith('\\n') && document.querySelectorAll('.co-message-user').length === 1"), "Shift+Enter must not submit");
 await browser("fill", "textarea", questionEnter); await browser("press", "Enter");
 await waitDom("document.querySelectorAll('.co-message-assistant').length === 2", "Enter sends question");
 check("enterSendsExactlyOnce", receipt.mock.classifications.filter(item => item.text === questionEnter).length === 1, receipt.mock.classifications);
 await browser("fill", "textarea", completedTask); await browser("click", ".co-send");
 await waitDom("!!document.querySelector('.co-status-verified')", "native execution review and coverage", 15000);
 check("nativeEvidenceDisplayed", await evaluate("document.querySelector('.co-evidence')?.textContent.includes('BROWSER_EVIDENCE') && !![...document.querySelectorAll('summary')].find(el => el.textContent === '原生执行与检查记录')"), "verified task requires coverage evidence and native details");
 await browser("click", ".co-task summary");
 check("nativeDetailsExpand", await evaluate("document.querySelector('.co-task details')?.open && document.querySelector('.co-task details').textContent.includes('BROWSER_REVIEW')"), "real native review feedback should be expandable");
 await screenshot("desktop-evidence.png");
 const evidenceDom = await captureDom("desktop-evidence-dom.json");
 if (evidenceDom.text.includes("正在使用：BROWSER_EXECUTION")) receipt.observations.push({ code: "SUMMARY_SHOWN_AS_TOOL", severity: "presentation", evidence: "desktop-evidence.png", detail: "Verified task repeats executor summary under 正在使用 although this fixture invoked no tool." });
 if (evidenceDom.text.includes("未提供结束时间")) receipt.observations.push({ code: "VERIFIED_END_TIME_MISSING", severity: "presentation", evidence: "desktop-evidence.png", detail: "Verified task cannot show elapsed duration because completion timestamp is absent." });
 await browser("fill", "textarea", heldTask); await browser("press", "Enter");
 await waitDom("!!document.querySelector('.co-status-running')", "held native task");
 await wait(() => held.size > 0, "held loopback executor");
 check("taskPauseCancelEnabled", await evaluate("['pause','cancel'].every(action => !!document.querySelector('[data-action='+action+']:not(:disabled)'))"), "running task needs actionable pause/cancel");
 await browser("set", "viewport", "390", "844");
 await browser("fill", "textarea", questionHeld); await browser("click", ".co-send");
 await waitDom("document.querySelectorAll('.co-message-assistant').length === 4", "mobile foreground answer while native executor remains held");
 check("questionWhileExecutorHeld", held.size > 0 && await evaluate("!!document.querySelector('.co-status-running') && [...document.querySelectorAll('.co-message-assistant')].at(-1).textContent.includes('2 个任务')"), "question must answer without settling held task");
 await browser("scrollintoview", "[data-action=pause]");
 await screenshot("mobile-running.png");
 const mobile = await captureDom("mobile-running-dom.json"); checkLayout(mobile, "mobile");
 await browser("snapshot", "-i"); await save("mobile-snapshot.json", JSON.stringify(transcript.at(-1)));
 await browser("click", "[data-action=pause]");
 await waitDom("!!document.querySelector('.co-status-paused')", "pause confirmed by native executor", 10000);
 check("pauseButtonPersistsAsInboxRequest", receipt.mock.classifications.some(item => item.action === "pause" && item.targetId), receipt.mock.classifications);
 await browser("scrollintoview", "[data-action=resume]");
 const pausedDom = await captureDom("mobile-paused-dom.json");
 if (pausedDom.text.includes("已暂停") && pausedDom.text.includes("执行侧尚未确认停止")) receipt.observations.push({ code: "PAUSED_STOP_WARNING_STALE", severity: "presentation", evidence: "mobile-paused-dom.json", detail: "Confirmed paused task still says execution has not confirmed stopping." });
 await screenshot("mobile-paused.png");
 await browser("click", "[data-action=resume]");
 await waitDom("!!document.querySelector('.co-status-running')", "resume actual native task", 10000);
 await wait(() => held.size > 0, "resumed held executor");
 await browser("click", "[data-action=cancel]");
 await waitDom("!!document.querySelector('.co-status-cancelled')", "cancel confirmed by native executor", 10000);
 check("resumeCancelButtonsRouteToTask", ["resume", "cancel"].every(action => receipt.mock.classifications.some(item => item.action === action && item.targetId)), receipt.mock.classifications);
 await browser("reload");
 await waitDom("!!document.querySelector('.co-status-cancelled') && !!document.querySelector('.co-status-verified')", "task state retained on mobile reload");
 check("terminalTasksHaveNoControls", await evaluate("document.querySelectorAll('[data-action]').length === 0"), "terminal tasks must not expose pause/resume");
 const finalDom = await captureDom("mobile-final-dom.json");
 check("retainedAllRequests", finalDom.requests.length === 8 && new Set(finalDom.requests).size === 8, finalDom.requests);
 await screenshot("mobile-final.png");
 const errors = await browser("errors"); await save("browser-errors.json", JSON.stringify(errors, null, 2));
 check("noBrowserErrors", !(errors?.errors?.length), errors);
 check("nativeFixtureRoundTrip", receipt.mock.executorCalls >= 3 && receipt.mock.reviewCalls >= 1 && receipt.mock.coverageCalls === 1, receipt.mock);
 const authProbe=createServer();await new Promise(done=>authProbe.listen(0,'127.0.0.1',done));const authPort=authProbe.address().port;await new Promise(done=>authProbe.close(done));
 try{await access(join(agent,'auth.json'));}catch{await writeFile(join(agent,'auth.json'),'{}',{mode:0o600});}
 const authEnv={...browserEnv,NODE_OPTIONS:process.env.NODE_OPTIONS||'',PI_WEB_TOKEN:'fixture-only-browser-auth',PI_WEB_PLUGIN_CATALOG_URL:'off'};
 const launcher=join(project,'scripts/pi-coordinator.mjs');
 const args=['--state-dir',authState,'--native-agent-dir',agent,'--web-package',webDir,'--port',String(authPort),'--model','fixture-local/local','--workspace',cwd,'--no-open'];
 const authLaunch=await promisify(execFile)(process.execPath,[launcher,'start',...args],{env:authEnv,timeout:65000,maxBuffer:200000});
 check('authLauncherDoesNotClaimBrowserReady',authLaunch.stdout.includes('浏览器需完成原生访问口令认证')&&!authLaunch.stdout.includes(authEnv.PI_WEB_TOKEN),'backend probe authentication must not claim fresh browser authentication');
 const protectedUrl=`http://127.0.0.1:${authPort}/plugins-api/pi-coordinator/experience`;
 check('freshBrowserAuthGatePreserved',(await fetch(protectedUrl)).status===401,'unauthenticated browser entry must remain protected');
 const authenticated=await fetch(protectedUrl,{headers:{Authorization:`Bearer ${authEnv.PI_WEB_TOKEN}`}});
 check('nativeExistingAuthenticationWorks',authenticated.status===200&&!!authenticated.headers.get('set-cookie'),'existing native auth grants browser cookie, never a disabled auth wall');
 await promisify(execFile)(process.execPath,[launcher,'stop',...args],{env:authEnv,timeout:18000,maxBuffer:10000});
 receipt.ok = receipt.issues.length === 0; receipt.result = receipt.ok ? "PASS" : "FAIL";
}
let budget;
const deadline = new Promise((_, reject) => { budget = setTimeout(() => { const error = Error("guest browser QA exceeded 105s execution budget"); stop.abort(error); for (const proc of pendingCommands) proc.kill("SIGKILL"); reject(error); }, budgetMs); });
try { await Promise.race([main(), deadline]); }
catch (error) {
 receipt.error = error.stack; console.error(`BROWSER_QA_FAILURE ${error.stack}`);
 if (!stop.signal.aborted) {
  try { await screenshot("failure.png"); await captureDom("failure-dom.json"); } catch {}
  try { await command(["doctor", "--offline", "--quick"], 5000, { raw: true, allowFailure: true }); await save("browser-doctor.log", transcript.at(-1).stdout + transcript.at(-1).stderr); } catch {}
 }
}
finally {
 clearTimeout(budget);
 try{const owned=await json(join(authState,'launcher.json'));if(owned?.pid){const {stdout}=await promisify(execFile)('ps',['-p',String(owned.pid),'-o','command=']);if(stdout.includes(`--data-dir ${join(authState,'web')}`))process.kill(owned.pid,'SIGTERM');}}catch{}
 startupSocket?.close();
 if (browserStarted && !stop.signal.aborted) { try { await browser("close"); receipt.checks.browserClosed = true; } catch (error) { receipt.cleanupError = error.message; } }
 for (const proc of pendingCommands) proc.kill("SIGKILL");
 if (child?.pid) {
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  await delay(500);
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  try { process.kill(-child.pid, 0); receipt.cleanupError = "WebUI process group still alive"; } catch (error) { if (error.code === "ESRCH") receipt.checks.webuiProcessGroupCleaned = true; }
 }
 for (const response of held) response.destroy();
 provider?.closeAllConnections(); if (provider?.listening) await new Promise(done => provider.close(done));
 try { receipt.mock.externalAttempts = (await readFile(join(root, "network.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); } catch (error) { if (error.code !== "ENOENT") receipt.cleanupError = error.message; }
 if (receipt.mock.externalAttempts.length || receipt.cleanupError || !receipt.checks.browserClosed || !receipt.checks.webuiProcessGroupCleaned) { receipt.ok = false; receipt.result = "FAIL"; }
 receipt.elapsedMs = Date.now() - startedAt; receipt.childExit = childExit;
 await save("browser-transcript.json", JSON.stringify(transcript, null, 2));
 await save("webui-server.log", serverLog);
 await save("receipt.json", JSON.stringify(receipt, null, 2));
 for (const name of artifactNames) {
  const content = await readFile(join(artifacts, name));
  assert.ok(content.length <= 1500000, "bounded artifact transfer");
  console.log(`COORDINATOR_BROWSER_ARTIFACT ${JSON.stringify({ name, sha256: sha(content), base64: content.toString("base64") })}`);
 }
 console.log(`COORDINATOR_BROWSER_RESULT ${JSON.stringify({ ...receipt, sources: undefined, mock: { ...receipt.mock, classifications: receipt.mock.classifications.map(({ action, targetId }) => ({ action, targetId })) } })}`);
 process.exitCode = receipt.ok ? 0 : 1;
}
