#!/usr/bin/env bash
# Trusted host-side evidence decoding only; all applications ran in the guest.
set -euo pipefail
D=${1:?usage: assert.sh <run-dir>}
node - "$D" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dir = process.argv[2];
const out = fs.readFileSync(path.join(dir, 'guest/tmp/ah.out'), 'utf8');
const artifacts = path.join(dir, 'browser-artifacts');
fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const transferred = new Set();
for (const line of out.split('\n').filter(line => line.startsWith('COORDINATOR_BROWSER_ARTIFACT '))) {
 const item = JSON.parse(line.slice('COORDINATOR_BROWSER_ARTIFACT '.length));
 assert.match(item.name, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
 assert.ok(!transferred.has(item.name), 'unique artifact names');
 const content = Buffer.from(item.base64, 'base64');
 assert.ok(content.length <= 1500000, 'bounded artifact bytes');
 assert.equal(sha(content), item.sha256, `artifact transport integrity: ${item.name}`);
 fs.writeFileSync(path.join(artifacts, item.name), content, { mode: 0o600, flag: 'wx' });
 transferred.add(item.name);
}
const results = out.split('\n').filter(line => line.startsWith('COORDINATOR_BROWSER_RESULT '));
assert.equal(results.length, 1, 'one structured browser result required; inspect guest ah.err/runtime.json on early failure');
const summary = JSON.parse(results[0].slice('COORDINATOR_BROWSER_RESULT '.length));
const receipt = JSON.parse(fs.readFileSync(path.join(artifacts, 'receipt.json'), 'utf8'));
const root = process.env.AHSB_INPUT_ROOT;
assert.ok(root, 'immutable project input snapshot required');
const manifest = new Map(fs.readFileSync(path.join(dir, 'project-source.sha256'), 'utf8').trim().split('\n').map(line => {
 const match = /^([a-f0-9]{64})  \.\/(.+)$/.exec(line); assert.ok(match); return [match[2], match[1]];
}));
const declared = fs.readFileSync(path.join(process.env.AHSB_CASE_DIR, 'push'), 'utf8').trim().split('\n').map(line => line.split(':')[0]);
assert.deepEqual(Object.keys(receipt.sources).sort(), [...declared].sort(), 'entire declared plugin tree executed');
for (const file of declared) {
 const digest = sha(fs.readFileSync(path.join(root, file)));
 assert.equal(manifest.get(file), digest, `immutable source: ${file}`);
 assert.equal(receipt.sources[file], digest, `guest source: ${file}`);
}
for (const image of receipt.screenshots) {
 const buffer = fs.readFileSync(path.join(artifacts, image.name));
 assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
 assert.equal(sha(buffer), image.sha256); assert.equal(buffer.length, image.bytes);
 assert.equal(buffer.readUInt32BE(16), image.width); assert.equal(buffer.readUInt32BE(20), image.height);
}
assert.equal(summary.result, receipt.result);
assert.equal(fs.readFileSync(path.join(dir, 'guest/tmp/ah.rc'), 'utf8').trim(), '0', receipt.error || JSON.stringify(receipt.issues));
assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.ok, true); assert.equal(receipt.result, 'PASS');
assert.equal(receipt.platform, 'darwin'); assert.equal(receipt.modelQualityTest, false);
assert.deepEqual(receipt.uiComponents, {marked:'18.0.11',esbuild:'0.28.2'});
assert.equal(receipt.fixture, 'guest-loopback-deterministic'); assert.ok(receipt.elapsedMs < 120000);
const requirements = JSON.parse(fs.readFileSync(path.join(process.env.AHSB_CASE_DIR, 'requires.json'), 'utf8'));
assert.equal(receipt.pi, requirements.pi); assert.equal(receipt.webui, requirements['pi-web-ui']); assert.equal(receipt.agentBrowser, requirements['agent-browser']);
const runtime = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
assert.equal(runtime.ok, true); assert.equal(runtime.nativePty, true);
assert.deepEqual(receipt.mock.externalAttempts, []); assert.deepEqual(receipt.issues, []);
assert.ok(receipt.screenshots.length >= 7, 'desktop and mobile screenshot milestones');
for (const key of ['desktopNoHorizontalOverflow', 'desktopComposerVisible', 'desktopTaskScrollRegion', 'desktopLayout', 'mobileNoHorizontalOverflow', 'mobileComposerVisible', 'mobileTaskScrollRegion', 'mobileLayout', 'actualPluginActivated', 'authLauncherDoesNotClaimBrowserReady', 'freshBrowserAuthGatePreserved', 'nativeExistingAuthenticationWorks', 'matureMarkdownSafeRendering', 'sendInitiallyDisabled', 'sendEnabledAfterTyping', 'sendClearsComposer', 'retainedQuestionAfterReload', 'shiftEnterInsertsNewline', 'enterSendsExactlyOnce', 'nativeEvidenceDisplayed', 'nativeDetailsExpand', 'taskPauseCancelEnabled', 'questionWhileExecutorHeld', 'pauseButtonPersistsAsInboxRequest', 'resumeCancelButtonsRouteToTask', 'terminalTasksHaveNoControls', 'retainedAllRequests', 'noBrowserErrors', 'nativeFixtureRoundTrip', 'browserClosed', 'webuiProcessGroupCleaned']) assert.equal(receipt.checks[key], true, key);
for (const [name, width, height] of [['desktop-initial.png', 1440, 1000], ['mobile-running.png', 390, 844]]) {
 const image = receipt.screenshots.find(image => image.name === name); assert.ok(image); assert.equal(image.width, width); assert.equal(image.height, height);
}
console.log(`PASS: actual guest Chromium standalone page, send/Enter, durable reload, desktop/mobile, native evidence and pause/resume/cancel; evidence=${artifacts}`);
NODE
