/**
 * Contract probe for the vendored pi adapter.
 *
 * `adapters/pi/` holds code vendored from pi's own `examples/`, so it imports
 * symbols that are not a public API — `BorderedLoader`, `convertToLlm`,
 * `copyToClipboard`, `serializeConversation` and friends — spread over four
 * packages (`pi-coding-agent`, `pi-tui`, `pi-ai`, `typebox`).
 *
 * A version pin in `pinned-versions.json` only said "we once looked at 0.84.4":
 * it gated nothing, it covered one package out of four, and it stayed quiet
 * until someone ran the broken command. This probe reads the packages that are
 * actually installed and checks every value the adapter imports is still
 * exported. A rename fails here, at check time, naming the symbol.
 *
 * Two deliberate blind spots, so the result is read for what it is:
 *   - `import type { … }` is not gated: the transpiler erases types, so a
 *     renamed type cannot break the extension at runtime.
 *   - re-exports (`export * from …`) are followed a few hops; a package whose
 *     declarations cannot be resolved is reported as partially verified rather
 *     than failed, so the check never cries wolf.
 * What no static probe can see: a symbol that keeps its name but changes
 * signature or behaviour. That stays with the human eye the README's
 * residual-risk section asks for.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { REPO } from "./repo.mjs";

const ADAPTER_DIR = join(REPO, "adapters/pi");
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const MAX_REEXPORT_HOPS = 4;

/** Every value import from an external package, keyed by package specifier. */
export function importedSymbols(files) {
  const byPackage = new Map();
  const importRe = /\bimport\s+(?!type\b)([^;]*?)\s+from\s+["']([^"']+)["']/gs;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(importRe)) {
      const specifier = match[2];
      if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
      const braced = match[1].match(/\{([\s\S]*)\}/);
      // A default or namespace import claims only that the package resolves.
      if (!braced) continue;
      for (const raw of braced[1].split(",")) {
        const item = raw.trim();
        if (!item || item.startsWith("type ")) continue;
        const name = item.split(/\s+as\s+/)[0].trim();
        if (!name) continue;
        const set = byPackage.get(specifier) ?? new Set();
        set.add(name);
        byPackage.set(specifier, set);
      }
    }
  }
  return byPackage;
}

/**
 * Named exports of a package, read from its own type declarations rather than
 * imported: no side effects, and it covers values and types alike.
 */
export function declaredExports(packageRoot, specifier) {
  const candidates = [
    join(packageRoot, "node_modules", specifier),
    join(dirname(dirname(packageRoot)), specifier),
  ];
  for (const dir of candidates) {
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    const entry = pkg.exports?.["."];
    const relTypes = (entry && typeof entry === "object" ? entry.types : undefined) ?? pkg.types ?? pkg.typings;
    if (!relTypes) return { present: true, names: null, partial: "ships no type declarations" };
    const declarations = join(dir, relTypes);
    if (!existsSync(declarations)) {
      return { present: true, names: null, partial: `declarations missing at ${relative(dir, declarations)}` };
    }
    const { names, unresolved } = declaredNames(declarations);
    if (!names.size) return { present: true, names: null, partial: "no enumerable exports in its declarations" };
    return { present: true, names, partial: unresolved.length ? `${unresolved.length} re-export target(s) unresolved` : "" };
  }
  return { present: false, names: null, partial: "not installed next to pi" };
}

/**
 * Names declared in a `.d.ts`, following `export * from …` a few hops because
 * pi's barrels lean on it heavily (`export * from "./api/lazy.ts"`). A target
 * that cannot be resolved is collected instead of guessed at.
 */
export function declaredNames(declarationsPath, seen = new Set(), hops = 0) {
  const names = new Set();
  const unresolved = [];
  if (seen.has(declarationsPath) || hops > MAX_REEXPORT_HOPS) return { names, unresolved };
  seen.add(declarationsPath);
  const source = readFileSync(declarationsPath, "utf8");

  // Barrel files are machine-written, so names sit in `export { … }` lists.
  for (const match of source.matchAll(/export\s*(?:type\s*)?\{([^}]*)\}/g)) {
    for (const raw of match[1].split(",")) {
      const item = raw.trim().replace(/^type\s+/, "");
      if (!item) continue;
      // `export { local as Public }` publishes Public.
      const parts = item.split(/\s+as\s+/);
      names.add(parts[parts.length - 1].trim());
    }
  }
  for (const match of source.matchAll(/export\s+(?:declare\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]);
  }
  // `export * as Type from "./x.mjs"` publishes the namespace as a name.
  for (const match of source.matchAll(/export\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from/g)) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/export\s*\*\s*from\s*["']([^"']+)["']/g)) {
    const target = resolveDeclaration(dirname(declarationsPath), match[1]);
    if (!target) {
      unresolved.push(match[1]);
      continue;
    }
    const nested = declaredNames(target, seen, hops + 1);
    for (const name of nested.names) names.add(name);
    unresolved.push(...nested.unresolved);
  }
  return { names, unresolved };
}

/** `export * from "./x.ts"` or `"./x.mjs"` names the source file; only the `.d.ts` / `.d.mts` ships. */
function resolveDeclaration(dir, specifier) {
  const base = specifier.replace(/\.(m|c)?(ts|js)$/, "");
  for (const suffix of [".d.ts", ".d.mts", ".d.cts"]) {
    const candidate = join(dir, `${base}${suffix}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** The pi on PATH decides which packages count as installed. */
export function piPackageRoot() {
  const bin = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
  let dir = dirname(realpathSync(bin));
  for (let hop = 0; hop < 6; hop += 1) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, "utf8")).name === PI_PACKAGE) return dir;
      } catch {
        /* keep walking up */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function adapterFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) files.push(...adapterFiles(abs));
    else if (abs.endsWith(".ts") || abs.endsWith(".tsx")) files.push(abs);
  }
  return files;
}

export function checkAdapterContract() {
  const name = "adapter contract";
  if (!existsSync(ADAPTER_DIR)) return { name, status: "skip", detail: "no adapters/pi directory" };

  let packageRoot;
  try {
    packageRoot = piPackageRoot();
  } catch {
    packageRoot = null;
  }
  if (!packageRoot) return { name, status: "skip", detail: "pi is not installed; nothing to check the adapter against" };

  const byPackage = importedSymbols(adapterFiles(ADAPTER_DIR));
  const problems = [];
  const partial = [];
  let symbols = 0;

  for (const specifier of [...byPackage.keys()].sort()) {
    const wanted = byPackage.get(specifier);
    const { present, names, partial: why } = declaredExports(packageRoot, specifier);
    if (!present) {
      problems.push(`${specifier}: ${why}`);
      continue;
    }
    if (!names) {
      partial.push(`${specifier} (${why})`);
      continue;
    }
    const missing = [...wanted].filter((symbol) => !names.has(symbol)).sort();
    if (missing.length) problems.push(`${specifier}: no longer exports ${missing.join(", ")}`);
    else symbols += wanted.size;
    if (why) partial.push(`${specifier} (${why})`);
  }

  if (!symbols && !problems.length) {
    return { name, status: "skip", detail: "no external symbols found in the adapter" };
  }
  const detail = `${symbols} symbols from ${byPackage.size} packages still exported`;
  return {
    name,
    status: problems.length ? "fail" : "pass",
    detail: partial.length ? `${detail}; partial: ${partial.join(", ")}` : detail,
    problems,
  };
}
