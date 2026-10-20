#!/usr/bin/env bash
set -euo pipefail
D=${1:?usage: assert.sh <run-dir>}
node - "$D" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dir = process.argv[2];
const out = fs.readFileSync(path.join(dir, 'guest/tmp/ah.out'), 'utf8');
const lines = out.split('\n').filter(line => line.startsWith('COORDINATOR_WEBUI_RECEIPT '));
assert.equal(lines.length, 1, 'exactly one structured guest receipt required');
const receipt = JSON.parse(lines[0].slice('COORDINATOR_WEBUI_RECEIPT '.length));
const rc = fs.readFileSync(path.join(dir, 'guest/tmp/ah.rc'), 'utf8').trim();
const manifest = fs.readFileSync(path.join(dir, 'project-source.sha256'), 'utf8');
const root = process.env.AHSB_INPUT_ROOT;
assert.ok(root, 'sandbox immutable input snapshot required for source verification');
const hashes = new Map(manifest.trim().split('\n').map(line => {
  const match = /^([a-f0-9]{64})  \.\/(.+)$/.exec(line);
  assert.ok(match, 'invalid source hash manifest');
  return [match[2], match[1]];
}));
const expectedSources = ['scripts/tests/coordinator-webui-guest.mjs', ...['index.mjs', 'coordinator.mjs', 'webui-executor.mjs', 'coverage.mjs', 'manifest.json', 'client/entry.mjs', 'client/outbox.mjs'].map(name => `adapters/pi/coordinator-webui/${name}`)];
assert.deepEqual(Object.keys(receipt.sources).sort(), [...expectedSources].sort());
for (const file of expectedSources) {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
  assert.equal(hashes.get(file), digest, `snapshot identity: ${file}`);
  assert.equal(receipt.sources[file], digest, `guest executed source: ${file}`);
}
assert.equal(receipt.schemaVersion, 1);
assert.equal(receipt.platform, 'darwin');
const requirements = JSON.parse(fs.readFileSync(path.join(process.env.AHSB_CASE_DIR, 'requires.json'), 'utf8'));
assert.equal(receipt.pi, requirements.pi); assert.equal(receipt.webui, requirements['pi-web-ui']);
const runtime = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
assert.equal(runtime.ok, true); assert.equal(runtime.nativePty, true); assert.equal(runtime.platform, 'darwin');
assert.equal(receipt.protocolTimeoutMs, 10000); assert.equal(receipt.totalBudgetMs, 90000);
assert.deepEqual(receipt.mock.externalAttempts, []);
assert.equal(receipt.checks.ownedProcessGroupCleaned, true);
if (receipt.result === 'NOT_READY') {
  assert.equal(rc, '78'); assert.equal(receipt.ok, false);
  assert.equal(receipt.gap.code, 'NATIVE_GOAL_SERVICE_2_REQUIRED');
  assert.ok(receipt.gap.missing.length > 0);
  console.error(`NOT_READY: ${JSON.stringify(receipt.gap)}`);
  process.exit(78);
}
assert.equal(rc, '0', receipt.error);
assert.equal(receipt.result, 'PASS'); assert.equal(receipt.ok, true);
assert.equal(receipt.classifier.mode, 'injected-no-tools'); assert.equal(receipt.classifier.modelQualityTest, false);
for (const key of ['actualPluginAcceptedAndAnswered', 'durableReceiptsBeforeClassification', 'queryAndNewTaskWhileExecutorHeld', 'autonomousTimerCheckpoint', 'externalTickAccepted', 'nativeReviewFailRetryPass', 'originalObjectivesPreserved', 'nativeQueuedGoalPassed', 'actualPluginCoverageRepair', 'actualPluginPauseResume', 'actualPluginCancellation', 'actualLongCommandInteractive', 'ownedToolProcessesStopped']) assert.equal(receipt.checks[key], true, key);
assert.equal(receipt.mock.executorCalls, 8); assert.equal(receipt.mock.reviewCalls, 6);
assert.equal(receipt.mock.coverageCalls, 3);
assert.equal(receipt.pluginTasks.length, 3); assert.equal(receipt.pluginTasks[1].status, 'verified'); assert.equal(receipt.pluginTasks[2].status, 'cancelled'); assert.equal(receipt.pluginTasks[0].coverageRepairs, 1); assert.equal(receipt.pluginTasks[0].revision, 2); assert.equal(receipt.pluginTasks[0].coverage.status, 'passed');
assert.ok(receipt.native.goals.some(goal => goal?.roles?.executor?.convId));
assert.ok(receipt.native.reviews.some(review => review.verdict === 'fail' && review.round === 1));
assert.ok(receipt.native.reviews.some(review => review.verdict === 'pass' && review.round === 2));
assert.equal(receipt.tasks.length, 2); assert.ok(receipt.tasks.every(task => task.status === 'verified' && task.revision === 1));
console.log('PASS: real isolated guest WebUI, durable foreground ingress during held executor, autonomous timer, native fail/retry/pass, original goals and source identity');
NODE
