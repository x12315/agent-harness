import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codexApprovalPolicyMatches, codexPermissionsText, piExtensionRuntimeProblems } from "../lib/runtime-validation.mjs";

const onRequest = '# Escalation Requests\n\n## How to request escalation\n- Provide the `sandbox_permissions` parameter with the value `"require_escalated"`';
const never = "Approval policy is currently never. Do not provide the sandbox_permissions for any reason.";
const permissionsMessage = (text, role = "developer") => ({ role, content: [{ text: `<permissions instructions>\n${text}\n</permissions instructions>` }] });

test("Codex on-request accepts user and automatic reviewers without accepting never", () => {
  const user = codexPermissionsText([permissionsMessage(onRequest)]);
  const automatic = codexPermissionsText([permissionsMessage(onRequest + '\n`approvals_reviewer` is `auto_review`')]);
  assert.equal(codexApprovalPolicyMatches(user, "on-request"), true);
  assert.equal(codexApprovalPolicyMatches(automatic, "on-request"), true);
  assert.equal(codexApprovalPolicyMatches(never, "on-request"), false);
  assert.equal(codexApprovalPolicyMatches(never + "\n" + onRequest, "on-request"), false);
  assert.equal(codexApprovalPolicyMatches(user, "never"), false);
  assert.equal(codexApprovalPolicyMatches(never, "never"), true);
  assert.equal(codexApprovalPolicyMatches('`approvals_reviewer` is `auto_review`', "on-request"), false);
  assert.equal(codexApprovalPolicyMatches("", "on-request"), false);
  assert.equal(codexApprovalPolicyMatches("", "never"), false);
  assert.equal(codexApprovalPolicyMatches(user, "unrecognized"), false);
});

test("permission evidence is native, singular, and cannot come from user or profile instructions", () => {
  assert.equal(codexPermissionsText([permissionsMessage(onRequest, "user")]), "");
  assert.equal(codexPermissionsText([{ role: "developer", content: [{ text: onRequest }] }]), "");
  assert.equal(codexPermissionsText([permissionsMessage(onRequest), permissionsMessage(never)]), "");
  const native = codexPermissionsText([
    permissionsMessage(never),
    { role: "developer", content: [{ text: onRequest }] },
    permissionsMessage(onRequest, "user"),
  ]);
  assert.equal(codexApprovalPolicyMatches(native, "never"), true);
  assert.equal(codexApprovalPolicyMatches(native, "on-request"), false);
});

test("Pi lifecycle errors fail even when RPC exited successfully", () => {
  const result = { status: 0, stderr: "", stdout: JSON.stringify({ type: "extension_error", extensionPath: "/hook.ts", event: "session_start", error: "HOOK_FAILED" }) };
  assert.match(piExtensionRuntimeProblems(result).join("\n"), /HOOK_FAILED/);
  assert.ok(piExtensionRuntimeProblems({ status: 1, stderr: "load failed", stdout: "" }).length);
  assert.ok(piExtensionRuntimeProblems({ status: 0, stderr: "warning", stdout: "" }).length);
  assert.ok(piExtensionRuntimeProblems({ status: null, error: new Error("timeout") }).length);
});

const havePi = spawnSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).status === 0;
test("real Pi loads event-only extensions but rejects bad factories and hook failures", { skip: !havePi }, () => {
  const root = mkdtempSync(join(tmpdir(), "harness-hook-validation-"));
  const extension = join(root, "hook.ts");
  const marker = join(root, "started");
  const run = () => spawnSync("pi", ["--offline", "--no-extensions", "--extension", extension, "--no-skills", "--no-session", "--mode", "rpc"], {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent") },
    input: '{"id":"commands","type":"get_commands"}\n',
    encoding: "utf8",
    timeout: 15_000,
  });
  try {
    writeFileSync(extension, `import { writeFileSync } from "node:fs";\nexport default function(pi) { pi.on("session_start", () => writeFileSync(${JSON.stringify(marker)}, "started")); }\n`);
    const loaded = run();
    assert.deepEqual(piExtensionRuntimeProblems(loaded), []);
    assert.ok(existsSync(marker), "the event handler actually ran");
    const response = loaded.stdout.split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }).find((event) => event.command === "get_commands");
    assert.ok(response, "Pi answered the RPC command");
    assert.equal(response.data.commands.some((command) => command.source === "extension"), false, "the fixture registers no commands or tools");

    writeFileSync(extension, 'export default function() { throw new Error("BAD_FACTORY"); }\n');
    assert.ok(piExtensionRuntimeProblems(run()).length, "broken factories must still fail");
    writeFileSync(extension, 'export default function(pi) { pi.on("session_start", () => { throw new Error("BAD_HOOK"); }); }\n');
    assert.ok(piExtensionRuntimeProblems(run()).length, "broken lifecycle hooks must still fail");
    rmSync(extension);
    assert.ok(piExtensionRuntimeProblems(run()).length, "missing extension files must still fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
