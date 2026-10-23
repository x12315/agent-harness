import test from "node:test";
import assert from "node:assert/strict";
import { coverageGate } from "./coverage.mjs";
const task = { sourceText: "Investigate timeout and verify the fix", objective: "Investigate timeout", amendments: [] };
const gate = (value) => coverageGate({ llm: { complete: async () => ({ ok: true, text: JSON.stringify(value) }) } });

test("native success alone cannot supply whole-objective coverage evidence", async () => {
	assert.equal((await gate({ complete: true, checked: [], missing: [] })(task, { feedback: "pass" })).status, "unknown");
});
test("whole-objective check can expose a requirement the worker never claimed complete", async () => {
	const result = await gate({ complete: false, checked: [{ requirement: "Investigate timeout", evidence: "Trace identifies connection pool" }], missing: [{ requirement: "verify the fix", evidenceGap: "No regression test result" }] })(task, {});
	assert.equal(result.status, "missing"); assert.equal(result.missing[0].requirement, "verify the fix");
});
test("coverage cannot create a new requirement or approve missing evidence", async () => {
	assert.equal((await gate({ complete: false, checked: [], missing: [{ requirement: "Deploy production", evidenceGap: "deploy" }] })(task, {})).status, "unknown");
	assert.equal((await gate({ complete: true, checked: [{ requirement: "Investigate timeout", evidence: "" }], missing: [] })(task, {})).status, "unknown");
});
test("consistent bounded evidence approves, model failure and malformed JSON remain unknown", async () => {
	assert.equal((await gate({ complete: true, checked: [{ requirement: "Investigate timeout and verify the fix", evidence: "Native tools recorded reproduction and regression command output" }], missing: [] })(task, {})).status, "passed");
	assert.equal((await coverageGate({ llm: { complete: async () => ({ ok: false }) } })(task, {})).status, "unknown");
	assert.equal((await coverageGate({ llm: { complete: async () => ({ ok: true, text: "pass" }) } })(task, {})).status, "unknown");
});
