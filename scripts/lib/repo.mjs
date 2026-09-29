/**
 * Shared repo facts for the harness scripts. Node built-ins only, no deps.
 *
 * The repo is the single source of truth; harness native paths are projections.
 * "Own" skills are defined by the .gitignore whitelist, not by a hardcoded list,
 * so the two can never drift apart.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const HOME = process.env.HOME ?? "";
export const SKILLS_DIR = join(REPO, "skills");
/** Engineering declaration (shared, versioned). Personalization must NOT live here. */
export const SHARED_PI_SETTINGS = join(REPO, "adapters/pi/settings.json");
/** Machine-local pi settings: a real file, merged by bootstrap, never a projection. */
export const LOCAL_PI_SETTINGS = join(HOME, ".pi/agent/settings.json");
/** pi-profile-switch keeps declarations separate from its machine-local state/instances. */
export const PI_PROFILE_SWITCH_ROOT = join(HOME, ".pi-profile-switch");
export const PI_PROFILE_CONFIG_SKILL = join(HOME, ".pi/agent/skills/profile-config/SKILL.md");
/** Keys shared through ordinary Pi settings. Profile model defaults live in profiles/. */
export const ENGINEERING_SETTING_KEYS = ["packages", "skills"];
export const LOCK_PATH = join(REPO, ".skill-lock.json");
export const GAPS_PATH = join(REPO, "scripts/expected-gaps.json");
export const PINS_PATH = join(REPO, "scripts/pinned-versions.json");

export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
/** Expand the one portable machine-path token accepted by adapter settings. */
export function engineeringPiSettings() {
  const shared = readJson(SHARED_PI_SETTINGS);
  const expand = (value) => Array.isArray(value)
    ? value.map(expand)
    : typeof value === "string"
      ? value.replaceAll("{{HOME}}", HOME)
      : value;
  return Object.fromEntries(ENGINEERING_SETTING_KEYS.filter((key) => key in shared).map((key) => [key, expand(shared[key])]));
}
export const lockSkills = () => readJson(LOCK_PATH).skills ?? {};
export const pins = () => readJson(PINS_PATH);

/** Own skills come from the .gitignore whitelist: `!/skills/<name>/`. */
export function ownSkills() {
  const own = new Set();
  for (const raw of readFileSync(join(REPO, ".gitignore"), "utf8").split("\n")) {
    const m = /^!\/skills\/([^/]+)\/$/.exec(raw.trim());
    if (m) own.add(m[1]);
  }
  return own;
}

/** Skills that actually exist on disk, split into real skills and stray dirs. */
export function diskSkills() {
  const skills = new Set();
  const nonSkillDirs = [];
  if (!existsSync(SKILLS_DIR)) return { skills, nonSkillDirs };
  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue; // dot-dirs are inert, never skills
    const path = join(SKILLS_DIR, entry.name);
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (existsSync(join(path, "SKILL.md"))) skills.add(entry.name);
    else nonSkillDirs.push(entry.name);
  }
  return { skills, nonSkillDirs };
}

export const minus = (a, b) => [...a].filter((x) => !b.has(x)).sort();

/** Declaration vs reality, plus the disagreements, computed one way only. */
export function classify() {
  const lock = lockSkills();
  const declared = new Set(Object.keys(lock));
  const own = ownSkills();
  const { skills: disk, nonSkillDirs } = diskSkills();
  return {
    lock,
    declared,
    own,
    disk,
    nonSkillDirs,
    declaredNotInstalled: minus(declared, new Set([...disk, ...own])),
    installedNotDeclared: minus(disk, new Set([...declared, ...own])),
    ownNotOnDisk: minus(own, disk),
    alsoDeclared: [...own].filter((n) => declared.has(n)).sort(),
    typeCounts: Object.values(lock).reduce((acc, e) => {
      acc[e.sourceType ?? "?"] = (acc[e.sourceType ?? "?"] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

/** Every path we manage: [repo-relative source, absolute projection target]. */
export function managedLinks() {
  const links = [
    ["AGENTS.md", join(HOME, "AGENTS.md")],
    ["AGENTS.md", join(HOME, ".pi/agent/AGENTS.md")],
    // Codex reads AGENTS.md natively and reads .agents/skills directly, so it
    // needs no skill projection at all. Its $CODEX_HOME instruction file is the
    // author's own, versioned in adapters/codex/; the shared rules reach Codex
    // through ancestor discovery (~/AGENTS.md), see README's projection table.
    ["adapters/codex/AGENTS.md", join(HOME, ".codex/AGENTS.md")],
    // The catalog is versioned; runtime state and instances stay beside this
    // projection in ~/.pi-profile-switch and are never pulled into the repo.
    ["adapters/pi/profiles", join(PI_PROFILE_SWITCH_ROOT, "profiles")],
  ];
  const fileDirs = [
    ["adapters/pi/prompts", join(HOME, ".pi/agent/prompts")],
    ["adapters/pi/agents", join(HOME, ".pi/agent/agents")],
  ];
  for (const [from, toDir] of fileDirs) {
    const abs = join(REPO, from);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      if (name.endsWith(".md")) links.push([`${from}/${name}`, join(toDir, name)]);
    }
  }
  const codexProfiles = join(REPO, "adapters/codex/profiles");
  if (existsSync(codexProfiles)) {
    for (const name of readdirSync(codexProfiles)) {
      if (name.endsWith(".config.toml")) links.push([`adapters/codex/profiles/${name}`, join(HOME, ".codex", name)]);
    }
  }
  const extRoot = join(REPO, "adapters/pi/extensions");
  if (existsSync(extRoot)) {
    for (const entry of readdirSync(extRoot, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".ts")) {
        links.push([`adapters/pi/extensions/${entry.name}`, join(HOME, ".pi/agent/extensions", entry.name)]);
      } else if (entry.isDirectory()) {
        for (const name of readdirSync(join(extRoot, entry.name))) {
          if (name.endsWith(".ts")) {
            links.push([
              `adapters/pi/extensions/${entry.name}/${name}`,
              join(HOME, ".pi/agent/extensions", entry.name, name),
            ]);
          }
        }
      }
    }
  }
  return links;
}

export const relTarget = (fromDir, toAbs) => {
  const r = relative(fromDir, toAbs);
  return r.startsWith(".") ? r : `./${r}`;
};

export const isInsideRepo = (p) => {
  try {
    const real = realpathSync(p);
    return real === REPO || real.startsWith(REPO + "/");
  } catch {
    return false;
  }
};

export const isSymlink = (p) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
