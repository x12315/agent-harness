#!/usr/bin/env bash
set -euo pipefail
D=${1:?usage: assert.sh <run-dir>}
node - "$D" linux <<'NODE'
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const [dir,platform]=process.argv.slice(2);
assert.equal(fs.readFileSync(path.join(dir,'guest/tmp/ah.rc'),'utf8').trim(),'0');
const out=fs.readFileSync(path.join(dir,'guest/tmp/ah.out'),'utf8');
const line=out.split('\n').find(line=>line.startsWith('OBSERVER_SETTLEMENT_RECEIPT '));
assert.ok(line,'native guest receipt missing');const receipt=JSON.parse(line.slice('OBSERVER_SETTLEMENT_RECEIPT '.length));
assert.equal(receipt.platform,platform);assert.equal(receipt.pi,'0.87.1');assert.equal(receipt.webui,'0.96.1');
assert.equal(receipt.nativeWorkers,2);assert.equal(receipt.localTaskCalls,2);assert.equal(receipt.localSummaryCalls,2);assert.equal(receipt.externalProviderRequests,0);
for(const key of ['ok','settlementHidesOnlyOwningPanel','cachedReplayRetainedWithoutPanel','nativeReloadRetainsFactsWithoutPanel','attentionAndAcknowledgmentPreserved','automaticOffPreserved','exitSnapshotCleanup'])assert.equal(receipt[key],true,key);
assert.ok(fs.readFileSync(path.join(dir,'project-source.sha256'),'utf8').includes('adapters/pi/extensions/pi-observer.ts'));
const runtime=JSON.parse(fs.readFileSync(path.join(dir,'runtime.json'),'utf8'));assert.equal(runtime.ok,true);assert.equal(runtime.nativePty,true);assert.equal(runtime.platform,platform);
console.log('PASS: current Engine source in requested VM; two native Pi PTYs, settlement, scoped hiding, cache, attention, reload, off, local-only calls and cleanup');
NODE
