#!/usr/bin/env node
/**
 * Look for credentials in this repo. Read-only, no dependencies.
 *
 *   node scripts/secret-scan.mjs             tracked and unignored new source files (default)
 *   node scripts/secret-scan.mjs --staged    the staged diff, for pre-commit
 *   node scripts/secret-scan.mjs --history   every commit reachable from HEAD
 *
 * Exit 0 when clean, 1 on a hit. Matched values are masked: this script must
 * never become the leak it is looking for. Credentials belong in the macOS
 * Keychain or an environment variable (see the ssh-mcp setup for the pattern),
 * never in a tracked file.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ENGINE, REPO } from "./lib/repo.mjs";

const PATTERNS = [
  ["openai/anthropic key", /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g],
  ["tavily key", /\btvly-[A-Za-z0-9_-]{20,}\b/g],
  ["github token", /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/g],
  ["google api key", /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ["xai key", /\bxai-[A-Za-z0-9]{20,}\b/g],
  ["aws access key id", /\bAKIA[0-9A-Z]{16}\b/g],
  ["slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ["huggingface token", /\bhf_[A-Za-z0-9]{30,}\b/g],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
];
/** A credential-shaped field name carrying a literal value long enough to be real. */
const NAMED = /"(?:api[_-]?key|apikey|secret|token|password|passphrase)"\s*:\s*"([^"$]{16,})"/gi;
const PLACEHOLDER = /(example|placeholder|your[-_]|changeme|redacted|\bxxxx|\$\{|<[^>]+>)/i;

const mask = (v) => `${v.slice(0, 4)}…${v.slice(-2)} (len ${v.length})`;

export function scanText(label, text) {
  const hits = [];
  text.split("\n").forEach((line, i) => {
    for (const [name, re] of PATTERNS) {
      re.lastIndex = 0;
      const m = re.exec(line);
      if (m) hits.push({ where: `${label}:${i + 1}`, what: name, sample: mask(m[0]) });
    }
    NAMED.lastIndex = 0;
    const n = NAMED.exec(line);
    if (n && !PLACEHOLDER.test(n[1])) {
      hits.push({ where: `${label}:${i + 1}`, what: "literal credential field", sample: mask(n[1]) });
    }
  });
  return hits;
}

const git = (root, args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Cannot scan Git source tree: ${root}`);
  return result.stdout ?? "";
};

function trackedHits(root) {
  const hits = [];
  for (const path of new Set(git(root, ["ls-files", "--cached", "--others", "--exclude-standard"]).split("\n").filter(Boolean))) {
    let text;
    try {
      text = readFileSync(join(root, path), "utf8");
    } catch {
      continue; // binary or unreadable
    }
    if (text.includes("\u0000")) continue;
    hits.push(...scanText(path, text));
  }
  return hits;
}

function stagedHits(root) {
  const diff = git(root, ["diff", "--cached", "-U0", "--no-color"]);
  let file = "?";
  const hits = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) file = line.slice(6);
    else if (line.startsWith("+") && !line.startsWith("+++")) {
      hits.push(...scanText(`${file} (staged)`, line.slice(1)));
    }
  }
  return hits;
}

function historyHits(root) {
  return scanText("history (all commits)", git(root, ["log", "-p", "--all", "--no-color"]));
}

export function run({ mode = "tracked", staged = false, history = false, scanRoot, json = false } = {}) {
  mode = history ? "history" : staged ? "staged" : mode;
  const roots = [...new Set(scanRoot ? [scanRoot] : [ENGINE, REPO])];
  const hits = roots.flatMap((root) => (mode === "staged" ? stagedHits(root) : mode === "history" ? historyHits(root) : trackedHits(root)).map((hit) => ({ ...hit, where: `${root}/${hit.where}` })));
  const ok = hits.length === 0;
  if (json) console.log(JSON.stringify({ ok, mode, roots, hits }, null, 2));
  else {
    for (const h of hits) console.log(`  ! ${h.where}  ${h.what}  ${h.sample}`);
    const scope = mode === "tracked" ? "tracked + untracked" : mode;
    console.log(ok ? `secret-scan (${scope}): OK` : `secret-scan (${scope}): FAILED - ${hits.length} hit(s); move the value to the Keychain or an env var`);
  }
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const mode = argv.includes("--history") ? "history" : argv.includes("--staged") ? "staged" : "tracked";
  process.exit(run({ mode, scanRoot: argv.find((arg) => arg.startsWith("--scan-root="))?.slice(12), json: argv.includes("--json") }));
}
