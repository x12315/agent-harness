import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ENGINE, assertCatalog, catalogArguments } from "../lib/repo.mjs";
import { applyCatalogJson } from "../lib/catalog-transaction.mjs";
import { hashText } from "../lib/web-catalog.mjs";
import { createWebFixture } from "./web-fixture.mjs";

function dataFixture() {
  const root = createWebFixture();
  rmSync(join(root,"scripts"),{recursive:true});
  rmSync(join(root,"schemas"),{recursive:true});
  rmSync(join(root,"adapters/pi/extensions"),{recursive:true});
  mkdirSync(join(root,"adapters/codex"),{recursive:true});
  writeFileSync(join(root,"adapters/codex/AGENTS.md"),"# Fixture Codex entry\n");
  writeFileSync(join(root,"adapters/pi/settings.json"),'{"packages":[],"skills":[]}');
  return root;
}

test("Catalog selection is explicit, versioned, canonical and keeps atomic --catalog distinct", () => {
  const root=dataFixture();
  try {
    const selected=catalogArguments([`--catalog=${root}`,"verify","--catalog"],{HOME:"/unused",HARNESS_CATALOG:"/unused"});
    assert.equal(selected.root,realpathSync(root));
    assert.deepEqual(selected.args,["verify","--catalog"]);
    assert.equal(catalogArguments(["--catalog-root",root],{HOME:"/unused"}).root,realpathSync(root));
    assert.equal(catalogArguments([],{HARNESS_REPO:root}).root,realpathSync(root));
    assert.throws(()=>catalogArguments(["--catalog-root"]));
    assert.throws(()=>catalogArguments([`--catalog=${root}`,`--catalog=${root}`]));
    assertCatalog(root);
    for(const value of [{schemaVersion:2},{schemaVersion:1,engine:"scripts/trap.mjs"}]) {
      writeFileSync(join(root,"harness.catalog.json"),JSON.stringify(value));
      assert.throws(()=>assertCatalog(root),/Unsupported/);
    }
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("One engine manages independent data-only Catalogs and never executes their scripts", () => {
  const roots=[dataFixture(),dataFixture()];
  const previousHome=process.env.HOME;
  try {
    for(const root of roots) {
      mkdirSync(join(root,"scripts"));
      writeFileSync(join(root,"scripts/harness.mjs"),`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(join(root,"trap-executed"))},'BAD');process.exit(99);`);
      const env={...process.env,HOME:join(root,"native-home"),HARNESS_CATALOG:roots.find(r=>r!==root)};
      delete env.PI_CODING_AGENT_DIR;
      const invoke=args=>execFileSync(process.execPath,[join(ENGINE,"scripts/harness.mjs"),`--catalog=${root}`,...args],{env,cwd:ENGINE,encoding:"utf8",timeout:30_000});
      invoke(["compose","--apply"]);
      invoke(["bootstrap","--apply"]);
      invoke(["verify","--catalog"]);
      const activeEnv={...env};delete activeEnv.HARNESS_CATALOG;delete activeEnv.HARNESS_REPO;
      const active=execFileSync(process.execPath,["--input-type=module","-e",`import {CATALOG} from ${JSON.stringify(new URL("../lib/repo.mjs",import.meta.url).href)};console.log(CATALOG);`],{env:activeEnv,encoding:"utf8"}).trim();
      assert.equal(active,realpathSync(root),"native TUI/CLI must find the activated Catalog without retaining CLI flags");
      assert.equal(realpathSync(join(root,"native-home/.local/bin/harness")),join(ENGINE,"bin/harness"));
      assert.equal(realpathSync(join(root,"native-home/.pi/agent/AGENTS.md")),realpathSync(join(root,"AGENTS.md")));
      assert.equal(realpathSync(join(root,"native-home/.pi/agent/extensions/harness-manager.ts")),join(ENGINE,"adapters/pi/extensions/harness-manager.ts"));
      assert.ok(readFileSync(join(root,"adapters/codex/profiles/medium.config.toml"),"utf8").includes("Standard Safety."),"Codex core rules must not depend on a user's pointer phrase");
    }
    const source=join(roots[0],"profiles/medium.json"), untouched=readFileSync(join(roots[1],"profiles/medium.json"),"utf8");
    const before=readFileSync(source,"utf8"),value=JSON.parse(before);value.label="Isolated rename";
    process.env.HOME=join(roots[0],"native-home");
    const saved=applyCatalogJson({repo:roots[0],source,value,expectedHash:hashText(before)});
    assert.equal(saved.ok,true,JSON.stringify(saved));
    assert.deepEqual(saved.logs.map(log=>log.name),["compose","catalog"]);
    assert.equal(readFileSync(join(roots[1],"profiles/medium.json"),"utf8"),untouched);
    assert.ok(roots.every(root=>!existsSync(join(root,"trap-executed"))));
    writeFileSync(join(roots[0],"harness.catalog.json"),'{"schemaVersion":2}');
    const failed=applyCatalogJson({repo:roots[0],source,value,expectedHash:hashText(readFileSync(source,"utf8"))});
    assert.equal(failed.status,400);
  } finally {process.env.HOME=previousHome;for(const root of roots)rmSync(root,{recursive:true,force:true});}
});
