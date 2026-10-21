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
const artifacts = path.join(dir, 'observer-artifacts');
fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const transferred = new Set();
for (const line of out.split('\n').filter(line => line.startsWith('OBSERVER_LAYER_ARTIFACT '))) {
  const item = JSON.parse(line.slice('OBSERVER_LAYER_ARTIFACT '.length));
  assert.match(item.name, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
  assert.ok(!transferred.has(item.name), 'unique artifact names');
  const content = Buffer.from(item.base64, 'base64');
  assert.ok(content.length > 0 && content.length <= 1500000, 'bounded artifact bytes');
  assert.equal(sha(content), item.sha256, `artifact transport integrity: ${item.name}`);
  fs.writeFileSync(path.join(artifacts, item.name), content, { mode: 0o600, flag: 'wx' });
  transferred.add(item.name);
}
const results = out.split('\n').filter(line => line.startsWith('OBSERVER_LAYER_RESULT '));
assert.equal(results.length, 1, 'exactly one structured guest receipt required; inspect guest ah.err, runtime.json and webui-server.log on early failure');
const summary = JSON.parse(results[0].slice('OBSERVER_LAYER_RESULT '.length));
const receipt = JSON.parse(fs.readFileSync(path.join(artifacts, 'receipt.json'), 'utf8'));

assert.equal(receipt.schemaVersion, 1);
assert.equal(receipt.ok, true, JSON.stringify(receipt.issues));
assert.equal(receipt.result, 'PASS', receipt.error || JSON.stringify(receipt.issues));
assert.equal(summary.result, receipt.result);
assert.equal(receipt.platform, 'darwin', 'guest macOS evidence only');
assert.equal(receipt.fixture, 'guest-loopback-deterministic');
assert.equal(receipt.modelQualityTest, false);
assert.ok(receipt.runtimeDir.startsWith('/Users/'), 'guest sandbox runtime required');
assert.ok(path.isAbsolute(receipt.workspace) && receipt.workspace.startsWith('/'), 'real workspace path required');
assert.ok(path.isAbsolute(receipt.observerDirectory) && !receipt.observerDirectory.startsWith(receipt.workspace), 'observer directory must be a separate granted directory');
assert.deepEqual(receipt.uiComponents, { marked: '18.0.11', esbuild: '0.28.2' });
assert.ok(receipt.elapsedMs > 0 && receipt.elapsedMs < 150000, `guest execution inside budget: ${receipt.elapsedMs}`);

const requirements = JSON.parse(fs.readFileSync(path.join(process.env.AHSB_CASE_DIR, 'requires.json'), 'utf8'));
assert.equal(receipt.pi, requirements.pi);
assert.equal(receipt.webui, requirements['pi-web-ui']);
assert.equal(receipt.agentBrowser, requirements['agent-browser']);
const runtime = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
assert.equal(runtime.ok, true, 'sandbox runtime check must pass');
assert.equal(runtime.nativePty, true, 'declared tools need a real native PTY');
assert.deepEqual(runtime.tools, { pi: requirements.pi, 'pi-web-ui': requirements['pi-web-ui'], 'agent-browser': requirements['agent-browser'] });
assert.equal(fs.readFileSync(path.join(dir, 'guest/tmp/ah.rc'), 'utf8').trim(), '0', receipt.error || JSON.stringify(receipt.issues));

// Every declared input was executed from the immutable snapshot, and the guest hashed the same bytes.
const root = process.env.AHSB_INPUT_ROOT;
assert.ok(root, 'immutable project input snapshot required');
const manifest = new Map(fs.readFileSync(path.join(dir, 'project-source.sha256'), 'utf8').trim().split('\n').map(line => {
  const match = /^([a-f0-9]{64})  \.\/(.+)$/.exec(line);
  assert.ok(match, 'invalid source hash manifest');
  return [match[2], match[1]];
}));
const declared = fs.readFileSync(path.join(process.env.AHSB_CASE_DIR, 'push'), 'utf8').trim().split('\n').map(line => line.split(':')[0]);
assert.ok(declared.length >= 30, 'entire declared plugin and test tree must be pushed');
assert.deepEqual(Object.keys(receipt.sources).sort(), [...declared].sort(), 'guest source hashes must cover exactly the declared push list');
for (const file of declared) {
  const digest = sha(fs.readFileSync(path.join(root, file)));
  assert.equal(manifest.get(file), digest, `immutable snapshot source: ${file}`);
  assert.equal(receipt.sources[file], digest, `guest executed source: ${file}`);
}

for (const image of receipt.screenshots) {
  const buffer = fs.readFileSync(path.join(artifacts, image.name));
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `PNG signature: ${image.name}`);
  assert.equal(sha(buffer), image.sha256);
  assert.equal(buffer.length, image.bytes);
  assert.equal(buffer.readUInt32BE(16), image.width, `PNG width: ${image.name}`);
  assert.equal(buffer.readUInt32BE(20), image.height, `PNG height: ${image.name}`);
}
assert.ok(receipt.screenshots.length >= 3, 'merged, control and mobile screenshots required');
for (const [name, width, height] of [['observer-merged.png', 1440, 1000], ['observer-control.png', 1440, 1000], ['observer-mobile.png', 390, 844]]) {
  const image = receipt.screenshots.find(item => item.name === name);
  assert.ok(image, `missing screenshot: ${name}`);
  assert.equal(image.width, width, `${name} width`);
  assert.equal(image.height, height, `${name} height`);
}

// Layered-view evidence: both frame kinds, only the recent legacy snapshot, three applied controls.
assert.deepEqual(receipt.frames.kinds, ['pi-session', 'webui-task']);
assert.deepEqual(receipt.legacy.snapshotIds, [receipt.legacy.liveSessionId]);
assert.ok(!receipt.legacy.snapshotIds.includes(receipt.legacy.expiredSessionId));
assert.ok(receipt.legacy.authorizedPayloads >= 1, 'authorized legacy payload must still arrive after the WS grant');
assert.ok(receipt.frames.capabilities.includes('pause') && receipt.frames.capabilities.includes('resume') && receipt.frames.capabilities.includes('cancel'));
assert.equal(receipt.frames.phases.paused, 'paused');
assert.ok(['running', 'starting'].includes(receipt.frames.phases.resumed), `resumed phase ${receipt.frames.phases.resumed}`);
assert.equal(receipt.frames.phases.cancelled, 'cancelled');
assert.equal(receipt.controls.length, 3);
for (const [action, prefix] of [['pause', 'pause:'], ['resume', 'resume:'], ['cancel', 'cancel:']]) {
  const control = receipt.controls.find(item => item.action === action);
  assert.ok(control, `missing ${action} control evidence`);
  assert.ok(control.appliedDetail.startsWith(prefix), `${action} receipt detail: ${control.appliedDetail}`);
  assert.ok(control.latencyMs > 0 && control.latencyMs < 25000, `${action} applied inside 25s: ${control.latencyMs}`);
  const statuses = control.states.map(state => state.status);
  assert.ok(statuses.includes('已生效'), `${action} must show a server receipt in the UI`);
  assert.notEqual(statuses[0], '已生效', `${action} must not show 已生效 before the server receipt`);
  assert.ok(statuses.includes('排队中') || control.states.some(state => state.disabled.every(Boolean)), `${action} pending state must be visible`);
}
assert.deepEqual(receipt.mock.externalAttempts, [], 'no non-loopback network attempts');
assert.match(receipt.registry.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/, 'guest update checks stay on the loopback stub registry');
assert.ok(receipt.registry.requests >= 0);
assert.deepEqual(receipt.issues, []);
for (const key of ['bothPluginsActivated', 'coordinatorClientBuildPresent', 'observerControlOwnerLogged', 'unapprovedViewHidesSnapshots', 'observerPathRequestNamesDirectory', 'legacyPayloadStillArrives', 'expiredSnapshotFilteredFromLegacy', 'taskFrameOwnedByCoordinator', 'framesIncludeBothKinds', 'framesControlRootShared', 'onlyRecentSessionFrame', 'sessionFrameOffersNoControlTarget', 'taskFrameCarriesObjective', 'expiredSnapshotFilteredFromFrames', 'capabilityAdvertisesOwnedActions', 'capabilityNamesBothSources', 'mergedSectionTitle', 'mergedGroupsShowBothKinds', 'renderedTaskObjectiveAndWorkspace', 'renderedSessionWorkspace', 'renderedSessionPhase', 'expiredSnapshotNeverRendered', 'piSessionFrameHasNoControls', 'taskFrameShowsAllControls', 'desktopNoHorizontalOverflow', 'pauseHasNoOptimisticReceipt', 'pausePendingBeforeReceipt', 'pauseAppliedReceipt', 'resumeHasNoOptimisticReceipt', 'resumeAppliedReceipt', 'cancelHasNoOptimisticReceipt', 'cancelAppliedReceipt', 'appliedLabelObservedForEveryControl', 'renderRetainsBothFrameKindsAfterCancel', 'mobileNoHorizontalOverflow', 'mobileObserverNoOverflow', 'mobileMergedSectionRetained', 'noBrowserErrors', 'noExternalBrowserRequests', 'fixtureHeldExecutor', 'taskObjectivePreserved', 'browserClosed', 'webuiProcessGroupCleaned']) {
  assert.equal(receipt.checks[key], true, `receipt check failed: ${key}`);
}
console.log(`PASS: guest WebUI 0.100.0/Pi 1.1.0 with pi-coordinator + pi-observer in one process, WS directory grant, merged session/task frames, real Chromium 已生效 pause/resume/cancel, desktop+mobile screenshots; evidence=${artifacts}`);
NODE
