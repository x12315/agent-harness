#!/usr/bin/env node
/** Exercise the human /harness path without sending a request to a model. */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { compose } from "./compose.mjs";

const profile = [...compose().profiles.keys()].sort()[0];
if (!profile) throw new Error("No Profile is available for the control-plane canary.");
const child = spawn("pi-profile", [profile, "--", "--mode", "rpc", "--no-session", "--offline"], {
  env: { ...process.env, PI_OFFLINE: "1" },
  stdio: ["pipe", "pipe", "pipe"],
  detached: process.platform !== "win32",
});
const decoder = new StringDecoder("utf8");
const events = [];
let stdoutBuffer = "";
let stderr = "";
let answered = false;
let failure;
let forceKillTimer;

function terminate(signal) {
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The child may already be gone.
  }
}

function fail(message) {
  if (failure) return;
  failure = message;
  terminate("SIGTERM");
  forceKillTimer = setTimeout(() => terminate("SIGKILL"), 2_000);
  forceKillTimer.unref();
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
  stdoutBuffer += decoder.write(chunk);
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
  clearTimeout(timeout);
  if (forceKillTimer) clearTimeout(forceKillTimer);
  stdoutBuffer += decoder.end();
  if (stdoutBuffer) handleLine(stdoutBuffer);
  const notification = events.find((event) =>
    event.type === "extension_ui_request"
      && event.method === "notify"
      && event.message?.includes("Harness Control Plane")
      && event.message?.includes(`当前 Pi    ${profile}`));
  const agentStarted = events.some((event) => event.type === "agent_start");
  const problems = [];
  if (failure) problems.push(failure);
  if (code !== 0) problems.push(`pi-profile exited ${code}`);
  if (!answered) problems.push("RPC prompt was not accepted");
  if (!notification) problems.push("control-plane status notification missing");
  if (agentStarted) problems.push("/harness incorrectly started the agent/model loop");
  if (stderr.trim()) problems.push(`stderr not empty: ${stderr.trim().slice(0, 160)}`);
  if (problems.length) {
    console.error(`control-plane canary: FAILED - ${problems.join("; ")}`);
    process.exitCode = 1;
  } else {
    console.log(`control-plane canary: OK (/harness status in ${profile}, zero model turns)`);
  }
});

child.stdin.write(`${JSON.stringify({ id: "harness-canary", type: "prompt", message: "/harness status" })}\n`);
const timeout = setTimeout(() => fail("timed out after 60s"), 60_000);
timeout.unref();
