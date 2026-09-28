#!/usr/bin/env node
/**
 * Reconcile declaration (.skill-lock.json) against reality (skills/).
 * Read-only. Exit 0 only when every difference is covered by expected-gaps.json.
 */
import { pathToFileURL } from "node:url";
import { GAPS_PATH, classify, ownSkills, readJson } from "./lib/repo.mjs";

export function run({ json = false } = {}) {
  const c = classify();
  const gaps = readJson(GAPS_PATH);
  const expected = {
    declaredNotInstalled: new Set(Object.keys(gaps.declaredNotInstalled ?? {})),
    installedNotDeclared: new Set(Object.keys(gaps.installedNotDeclared ?? {})),
  };

  const problems = [];
  if (c.alsoDeclared.length) problems.push(`own skills that are also declared third-party: ${c.alsoDeclared.join(", ")}`);
  if (c.ownNotOnDisk.length) problems.push(`whitelisted own skills missing on disk: ${c.ownNotOnDisk.join(", ")}`);
  for (const key of ["declaredNotInstalled", "installedNotDeclared"]) {
    const actual = c[key];
    const undocumented = actual.filter((n) => !expected[key].has(n));
    const stale = [...expected[key]].filter((n) => !actual.includes(n));
    if (undocumented.length) problems.push(`${key}: undocumented difference -> ${undocumented.join(", ")}`);
    if (stale.length) problems.push(`${key}: expected-gaps.json still lists (now resolved) -> ${stale.join(", ")}`);
  }
  for (const [name, reason] of Object.entries({ ...gaps.declaredNotInstalled, ...gaps.installedNotDeclared })) {
    if (!String(reason ?? "").trim()) problems.push(`expected-gaps.json: "${name}" has no reason`);
  }

  const ownOnDisk = [...c.own].filter((n) => c.disk.has(n)).length;
  const result = {
    ok: problems.length === 0,
    lock: { total: c.declared.size, byType: c.typeCounts },
    disk: { total: c.disk.size, declaredInstalled: c.disk.size - ownOnDisk, own: ownOnDisk },
    declaredNotInstalled: c.declaredNotInstalled,
    installedNotDeclared: c.installedNotDeclared,
    own: [...ownSkills()].sort(),
    nonSkillDirs: c.nonSkillDirs,
    problems,
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const types = Object.entries(c.typeCounts).map(([k, v]) => `${k} ${v}`).join(", ");
    console.log(`lock  ${c.declared.size}  (${types})`);
    console.log(`disk  ${c.disk.size}  = declared ${result.disk.declaredInstalled} + own ${result.disk.own} + unregistered ${c.installedNotDeclared.length}`);
    console.log(`declared-not-installed  ${c.declaredNotInstalled.length}  ${c.declaredNotInstalled.join(", ") || "-"}`);
    console.log(`installed-not-declared  ${c.installedNotDeclared.length}  ${c.installedNotDeclared.join(", ") || "-"}`);
    console.log(`own (gitignore whitelist)  ${result.own.join(", ") || "-"}`);
    if (c.nonSkillDirs.length) console.log(`non-skill dirs (inert)  ${c.nonSkillDirs.join(", ")}`);
    for (const p of problems) console.log(`  ! ${p}`);
    console.log(result.ok ? "reconcile: OK" : "reconcile: FAILED");
  }
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(run({ json: process.argv.includes("--json") }));
