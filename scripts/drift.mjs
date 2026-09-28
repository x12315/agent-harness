#!/usr/bin/env node
/**
 * Compare recorded well-known digests against the upstream discovery index.
 * Read-only, needs network. Exit 0 when nothing recorded has drifted.
 * Upstream skills we have not declared are reported but never fail the gate.
 */
import { pathToFileURL } from "node:url";
import { lockSkills } from "./lib/repo.mjs";

const INDEX_PATHS = [".well-known/agent-skills/index.json", ".well-known/skills/index.json"];
const strip = (d) => String(d ?? "").replace(/^sha256:/, "");

async function fetchIndex(base) {
  for (const rel of INDEX_PATHS) {
    const url = `${base.replace(/\/$/, "")}/${rel}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) continue;
      const body = await res.json();
      const skills = Array.isArray(body) ? body : (body.skills ?? []);
      return { url, map: new Map(skills.map((s) => [s.name, strip(s.digest)])) };
    } catch {
      /* try the legacy path next */
    }
  }
  return null;
}

export async function run({ json = false } = {}) {
  const lock = lockSkills();
  const groups = new Map();
  const noBaseUrl = [];
  for (const [name, entry] of Object.entries(lock)) {
    if (entry.sourceType !== "well-known") continue;
    const base = (entry.sourceBaseUrl ?? "").replace(/\/$/, "");
    if (!base) { noBaseUrl.push(name); continue; }
    if (!groups.has(base)) groups.set(base, new Map());
    groups.get(base).set(name, strip(entry.wellKnownDigest));
  }

  const sources = [];
  const errors = [];
  for (const [base, recorded] of groups) {
    const index = await fetchIndex(base);
    if (!index) { errors.push(`cannot fetch discovery index for ${base}`); continue; }
    const drifted = [], missingUpstream = [], noDigest = [];
    for (const [name, have] of recorded) {
      const upstream = index.map.get(name);
      if (upstream === undefined) missingUpstream.push(name);
      else if (!have) noDigest.push(name);
      else if (have !== upstream) drifted.push({ name, recorded: have.slice(0, 12), upstream: upstream.slice(0, 12) });
    }
    sources.push({
      base,
      index: index.url,
      recorded: recorded.size,
      upstream: index.map.size,
      drifted,
      missingUpstream,
      noDigest,
      upstreamOnly: [...index.map.keys()].filter((n) => !recorded.has(n)).sort(),
    });
  }

  const ok = errors.length === 0 && noBaseUrl.length === 0 &&
    sources.every((s) => s.drifted.length === 0 && s.missingUpstream.length === 0 && s.noDigest.length === 0);

  if (json) {
    console.log(JSON.stringify({ ok, sources, noBaseUrl, errors }, null, 2));
  } else {
    for (const s of sources) {
      console.log(`${s.base}`);
      console.log(`  recorded ${s.recorded} / upstream ${s.upstream}  via ${s.index}`);
      for (const d of s.drifted) console.log(`  ! drifted ${d.name}: recorded ${d.recorded} vs upstream ${d.upstream}`);
      if (s.missingUpstream.length) console.log(`  ! gone upstream: ${s.missingUpstream.join(", ")}`);
      if (s.noDigest.length) console.log(`  ! lock has no digest: ${s.noDigest.join(", ")}`);
      if (s.upstreamOnly.length) console.log(`  i not declared here: ${s.upstreamOnly.join(", ")}`);
    }
    for (const n of noBaseUrl) console.log(`  ! well-known entry without sourceBaseUrl: ${n}`);
    for (const e of errors) console.log(`  ! ${e}`);
    console.log(ok ? "drift: OK" : "drift: FAILED");
  }
  return ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await run({ json: process.argv.includes("--json") }));
