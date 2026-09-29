#!/usr/bin/env node
/** Exercise the human /harness path without sending a request to a model. */
import { spawn } from "node:child_process";

const child = spawn("pi-profile", ["ask", "--", "--mode", "rpc", "--no-session"], {
  stdio: ["pipe", "pipe", "pipe"],
});
const events = [];
let stdoutBuffer = "";
let stderr = "";
let answered = false;
let finished = false;

function fail(message) {
  if (finished) return;
  finished = true;
  child.kill("SIGTERM");
  console.error(`control-plane canary: FAILED - ${message}`);
  process.exitCode = 1;
}

function handleLine(line) {
  if (!line.trim()) return;
  let event;
  try { event = JSON.parse(line); }
  catch { fail(`non-JSON stdout: ${line.slice(0, 160)}`); return; }
  events.push(event);
  if (event.id === "harness-canary" && event.type === "response") {
    answered = event.success === true;
    child.stdin.end();
  }
}

child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString("utf8");
  while (true) {
    const newline = stdoutBuffer.indexOf("\n");
    if (newline < 0) break;
    let line = stdoutBuffer.slice(0, newline);
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    handleLine(line);
  }
});
child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
child.on("error", (error) => fail(error.message));
child.on("close", (code) => {
  if (finished) return;
  finished = true;
  if (stdoutBuffer) handleLine(stdoutBuffer);
  const notification = events.find((event) =>
    event.type === "extension_ui_request"
      && event.method === "notify"
      && event.message?.includes("Harness Control Plane")
      && event.message?.includes("当前 Pi    ask"));
  const agentStarted = events.some((event) => event.type === "agent_start");
  const problems = [];
  if (code !== 0) problems.push(`pi-profile exited ${code}`);
  if (!answered) problems.push("RPC prompt was not accepted");
  if (!notification) problems.push("control-plane status notification missing");
  if (agentStarted) problems.push("/harness incorrectly started the agent/model loop");
  if (stderr.trim()) problems.push(`stderr not empty: ${stderr.trim().slice(0, 160)}`);
  if (problems.length) {
    console.error(`control-plane canary: FAILED - ${problems.join("; ")}`);
    process.exitCode = 1;
  } else {
    console.log("control-plane canary: OK (/harness status in ask, zero model turns)");
  }
});

child.stdin.write(`${JSON.stringify({ id: "harness-canary", type: "prompt", message: "/harness status" })}\n`);
const timeout = setTimeout(() => fail("timed out after 60s"), 60_000);
timeout.unref();
