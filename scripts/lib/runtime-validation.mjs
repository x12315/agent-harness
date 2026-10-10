/** Report Pi CLI startup and lifecycle errors, including extensions that register no commands or tools. */
export function piExtensionRuntimeProblems(result) {
  const problems = [];
  if (result.error) problems.push(String(result.error.message ?? result.error));
  if (result.status !== 0) problems.push(`Pi exited ${result.status}`);
  if (result.stderr?.trim()) problems.push(result.stderr.trim().slice(0, 240));
  for (const line of (result.stdout ?? "").split("\n")) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "extension_error") {
      problems.push(`${event.extensionPath ?? "extension"} (${event.event ?? "unknown event"}): ${event.error ?? "unknown error"}`);
    }
  }
  return problems;
}

/** Extract the single native Codex permissions block; missing or ambiguous blocks fail closed. */
export function codexPermissionsText(messages) {
  const blocks = [];
  for (const message of messages) {
    if (message.role !== "developer") continue;
    for (const content of message.content ?? []) {
      const match = content.text?.match(/^<permissions instructions>\s*([\s\S]*?)\s*<\/permissions instructions>$/);
      if (match) blocks.push(match[1]);
    }
  }
  return blocks.length === 1 ? blocks[0] : "";
}

/** Check supported approval policies from native permissions, independently of the approvals reviewer. */
export function codexApprovalPolicyMatches(permissions, expected) {
  if (expected === undefined) return true;
  if (expected === "never") return /^Approval policy is currently never\./m.test(permissions);
  if (expected === "on-request") {
    return !/^Approval policy is currently (?!on-request\b)\S+/m.test(permissions)
      && /^# Escalation Requests\s*$/m.test(permissions)
      && /^## How to request escalation\s*$/m.test(permissions)
      && /`sandbox_permissions`[^\n]*`"?require_escalated"?`/.test(permissions);
  }
  return false;
}
