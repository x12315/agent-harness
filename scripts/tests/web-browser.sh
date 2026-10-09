#!/usr/bin/env bash
# Real-browser checks against web-browser-fixture.mjs only, never a live Catalog.
set -euo pipefail
STATE=${1:?fixture state JSON required}
EVIDENCE=${2:?external evidence directory required}
command -v node >/dev/null
command -v npx >/dev/null
mkdir -p "$EVIDENCE"
ROOT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).root)' "$STATE")
URL=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).url)' "$STATE")
case "$ROOT" in */harness-web-*) ;; *) echo "Not an isolated Web fixture" >&2; exit 2;; esac
ab() { npx --yes agent-browser@0.38.2 --session "${AGENT_BROWSER_SESSION:-harness-web-qa}" "$@"; }
check() { printf '%s\n' "$1" | ab eval --stdin; }
audit() {
  ab a11y --json > "$EVIDENCE/$1-a11y.json"
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1])).data;if(d.counts.violations)throw Error(JSON.stringify(d.violations));console.log("axe violations=0, manual-review="+d.counts.incomplete)' "$EVIDENCE/$1-a11y.json"
}
ab close >/dev/null 2>&1 || true
ab open "$URL"
ab snapshot -i > "$EVIDENCE/compare-snapshot.txt"
audit compare
ab screenshot "$EVIDENCE/compare-desktop.png"
check 'if(document.querySelectorAll(".configuration-row").length!==3||!document.querySelector("#inspector").hidden)throw Error("configuration list is missing or contains presentation sidebar");if(document.querySelector("#main h2").textContent!=="配置方案"||document.querySelector(".eyebrow, .profile-card"))throw Error("presentation UI returned"); "editable configuration list with product labels"'
ab fill '[data-action="profile-label"][data-profile="heavy"]' 'Renamed Configuration'
ab fill '[data-action="profile-description"][data-profile="heavy"]' 'Editable configuration description'
node -e 'if(require("fs").readFileSync(process.argv[1],"utf8").includes("Renamed Configuration"))throw Error("inline draft wrote source")' "$ROOT/profiles/heavy.json"
ab click '[data-action="save-profile"][data-profile="heavy"]'
ab click '#confirm-save'
ab wait --fn 'document.querySelector(`[data-profile-actions="heavy"] .configuration-status`)?.textContent==="已保存"'
node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1]));if(p.label!=="Renamed Configuration"||p.description!=="Editable configuration description")throw Error("inline edit not saved")' "$ROOT/profiles/heavy.json"
node -e 'const calls=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n");if(JSON.stringify(calls)!==JSON.stringify(["compose --apply","verify --catalog"]))throw Error("rename ran unnecessary checks: "+calls)' "$ROOT/calls.log"
check 'if(!document.querySelector("#toast-region").textContent.includes("增量检查通过"))throw Error("save result did not explain incremental scope"); "rename uses only static checks"'
ab fill '[data-action="profile-label"][data-profile="heavy"]' 'Discarded Name'
ab click '[data-action="reset-profile"][data-profile="heavy"]'
ab dialog accept
check 'if(document.querySelector(`[data-action="profile-label"][data-profile="heavy"]`).value!=="Renamed Configuration")throw Error("discard did not restore saved name"); "discard restores saved configuration"'
ab click '.configuration-actions [data-route="profile/medium"]'
ab focus '.skip-link'
ab press Enter
check 'if(location.hash!=="#profile/medium"||document.activeElement!==document.querySelector("#main"))throw Error("skip link changed the route or failed to focus main"); "skip link preserved route and focused content"'
audit profile
ab fill '[data-action="profile-label"]' 'Browser Draft Medium'
ab click '[data-route="profile/heavy"]'
ab fill '[data-action="profile-label"]' 'Other Profile Draft'
ab click '[data-route="profile/medium"]'
check 'if(!document.querySelector("[data-action=save-profile]")) throw Error("change tray missing"); "draft visible"'
node -e 'const j=require("fs").readFileSync(process.argv[1],"utf8");if(j.includes("Browser Draft Medium"))throw Error("draft wrote source prematurely")' "$ROOT/profiles/medium.json"
ab click '[data-action="inspect-instruction"][data-id="profile/implementation"]'
check 'if(!document.querySelector("[data-action=save-profile]"))throw Error("detail hid save"); "detail and change tray coexist"'
ab click '[data-action="close-detail"]'
ab click '[data-action="set-instruction-detail"][data-id="profile/implementation"][data-detail="detailed"]'
ab click '[data-action="move-instruction"][data-id="profile/model-standard"][data-direction="up"]'
check 'if(document.querySelector(".instruction-row [data-id]").dataset.id!=="profile/model-standard")throw Error("order not reflected visually");if(document.activeElement===document.body||document.activeElement.disabled)throw Error("reordering lost keyboard focus"); "visible order updated; focus retained"'
ab fill '[data-action="model-search"]' '61s'
check 'const options=[...document.querySelector("[data-action=pi-model]").options];if(!options.some(x=>x.value==="gpt-6.1-sol")||options.length>2)throw Error("fuzzy search failed to narrow results"); "fuzzy model search narrowed results"'
ab select '[data-action="pi-model"]' 'gpt-6.1-sol'
ab fill '[data-action="skill-search"]' 'lark'
ab click '[data-action="bulk-skills"][data-mode="disable"]'
check 'if([...document.querySelectorAll("[data-action=toggle-skill]")].some(x=>x.checked))throw Error("bulk disable failed"); "bulk skill change"'
ab click '.copy-settings summary'
ab select '[data-action="copy-source"]' 'heavy'
ab click '[data-action="copy-skills"]'
ab click '[data-action="undo-profile"]'
ab click '[data-action="inspect-effective"]'
check 'if(!document.querySelector("#inspector pre")?.textContent.includes("Standard Safety."))throw Error("effective preview omitted mandatory"); "effective preview"'
ab reload
check 'if(document.querySelector("[data-action=profile-label]").value!=="Browser Draft Medium")throw Error("draft recovery failed"); "draft recovery"'
ab click '[data-action="save-profile"]'
ab snapshot -i > "$EVIDENCE/review-snapshot.txt"
ab click '#confirm-save'
ab wait --fn 'document.querySelector("#inspector")?.textContent.includes("当前无修改")'
node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1]));if(p.label!=="Browser Draft Medium")throw Error("save did not persist")' "$ROOT/profiles/medium.json"
check 'if(!document.querySelector(`[data-route="profile/heavy"] .change-count`))throw Error("saving one Profile hid another draft"); "other Profile draft retained and discoverable"'
# CAS rejection must keep the browser draft for explicit reconciliation.
ab fill '[data-action="profile-label"]' 'Conflict Draft'
node -e 'const fs=require("fs"),p=process.argv[1],v=JSON.parse(fs.readFileSync(p));v.label="External Manager";fs.writeFileSync(p,JSON.stringify(v,null,2)+"\n")' "$ROOT/profiles/medium.json"
ab click '[data-action="save-profile"]'
ab click '#confirm-save'
ab wait '[data-action="review-conflict"]'
check 'if(document.querySelector("[data-action=profile-label]").value!=="Conflict Draft"||!document.querySelector("[data-action=save-profile]").disabled)throw Error("conflict lost draft or allowed save"); "CAS conflict preserved draft and blocked save"'
ab click '[data-action="review-conflict"]'
# Failed validation must restore source, retaining editable browser changes.
cp "$ROOT/profiles/medium.json" "$EVIDENCE/source-before-failure.json"
printf 'fail\n' > "$ROOT/fail-compose"
ab click '[data-action="save-profile"]'
ab click '#confirm-save'
ab wait --fn 'document.querySelector("#app")?.getAttribute("aria-busy")==="false"'
cmp "$ROOT/profiles/medium.json" "$EVIDENCE/source-before-failure.json"
rm "$ROOT/fail-compose"
check 'if(document.querySelector("[data-action=profile-label]").value!=="Conflict Draft")throw Error("validation failure lost draft"); "rollback retained draft"'
# Shared Markdown editing uses the same review/verified-save path.
ab click '[data-action="inspect-instruction"][data-id="profile/implementation"]'
ab click '[data-action="edit-instruction"]'
audit instruction-editor
ab fill '#instruction-text' $'## 实施模式\n\nBrowser fixture full variant replacement.\n'
ab click '[data-action="save-instruction-text"]'
ab click '#confirm-save'
ab wait --fn '!document.querySelector("#instruction-editor").open'
node -e 'if(!require("fs").readFileSync(process.argv[1],"utf8").includes("Browser fixture full variant replacement"))throw Error("Markdown save failed")' "$ROOT/instructions/profile/implementation.detailed.md"
# Mandatory stays locked and three variants remain available.
ab click '[data-route="global"]'
audit global
check 'if([...document.querySelectorAll("[data-action=global-toggle][data-id^=mandatory]")].some(x=>!x.disabled))throw Error("mandatory not locked"); "mandatory locked"'
ab click '[data-route="skills"]'
ab fill '[data-action="catalog-skill-search"]' 'lark-base'
ab click '[data-action="inspect-skill"][data-name="lark-base"]'
check 'if(!document.querySelector("#inspector").textContent.includes("Workspace"))throw Error("full description truncated"); "full skill description"'
audit skills
ab click '#main [data-route="profile/medium"][data-section="skills"]'
check 'if(document.activeElement.id!=="section-skills")throw Error("Skill configuration shortcut failed"); "Skill directory opens editable settings"'
ab click '.back-link'
ab set viewport 390 844
ab screenshot "$EVIDENCE/configurations-mobile.png"
check 'if(document.documentElement.scrollWidth>innerWidth)throw Error("configuration list overflow"); "editable list fits mobile"'
ab click '#primary-nav [data-route="profile/medium"]'
# Narrow-screen layout and accessible keyboard focus.
ab set viewport 390 844
ab click '[data-action="go-section"][data-section="general"]'
check 'if(document.activeElement.id!=="section-general")throw Error("section navigation failed"); "section navigation"'
ab screenshot "$EVIDENCE/profile-mobile.png"
check 'if(document.documentElement.scrollWidth>innerWidth)throw Error("mobile horizontal overflow");const tray=document.querySelector("#compact-tray").getBoundingClientRect();if(tray.height===0||tray.bottom>innerHeight+1)throw Error("mobile save tray not visible"); "mobile width contained; save tray always visible"'
ab fill '[data-action="skill-search"]' 'lark'
ab press Tab
check 'const focus=document.activeElement;if(focus===document.body||getComputedStyle(focus).outlineStyle==="none")throw Error("keyboard focus lost or invisible"); "keyboard focus outline visible"'
audit mobile
ab screenshot "$EVIDENCE/skills-mobile.png"
ab set viewport 1440 1000
check 'window.scrollTo(0,0); "desktop overview"'
ab screenshot "$EVIDENCE/profile-desktop.png"
ab click '.topbar [data-action="doctor"]'
ab wait --fn 'document.querySelector("#app").getAttribute("aria-busy")==="false"'
check 'if(location.hash!=="#health"||!document.querySelector(".health-output").textContent.includes("fixture doctor: OK"))throw Error("check results not visible"); "system checks open result view"'
audit health
# Profile lifecycle is exercised only in this temporary Catalog.
ab click '#primary-nav [data-route="compare"]'
ab click '[data-action="create-profile"]'
ab snapshot -i > "$EVIDENCE/create-profile-snapshot.txt"
audit create-profile
ab click '[data-action="cancel-create-profile"]'
ab click '[data-action="duplicate-profile"][data-profile="heavy"]'
check 'if(document.querySelector("#profile-create-label").value!=="Renamed Configuration 副本")throw Error("copy used an unsaved label"); "copy starts from saved source"'
ab fill '#profile-create-id' 'heavy'
ab click '#profile-create-submit'
check 'if(!document.querySelector("#profile-create-error").textContent.includes("已存在"))throw Error("duplicate ID not rejected"); "duplicate ID rejected"'
ab fill '#profile-create-id' 'custom-copy'
ab fill '#profile-create-label' 'Lifecycle Copy'
printf 'verify --catalog' > "$ROOT/fail-once"
ab click '#profile-create-submit'
ab wait --fn 'document.querySelector("#app").getAttribute("aria-busy")==="false"'
check 'if(!document.querySelector("#profile-create-dialog").open||document.querySelector("#profile-create-label").value!=="Lifecycle Copy"||!document.querySelector("#profile-create-error").textContent.includes("已恢复"))throw Error("create rollback lost input or error"); "failed creation retains form"'
test ! -e "$ROOT/profiles/custom-copy.json"
ab click '#profile-create-submit'
ab wait --fn 'location.hash==="#profile/custom-copy"'
node -e 'const fs=require("fs"),p=JSON.parse(fs.readFileSync(process.argv[1])),base=JSON.parse(fs.readFileSync(process.argv[2]));if(p.label!=="Lifecycle Copy"||JSON.stringify(p.adapters)!==JSON.stringify(base.adapters)||JSON.stringify(p.skills)!==JSON.stringify(base.skills))throw Error("copy mismatch")' "$ROOT/profiles/custom-copy.json" "$ROOT/profiles/heavy.json"
ab click '.back-link'
ab click '[data-action="create-profile"]'
ab set viewport 390 844
ab screenshot "$EVIDENCE/create-profile-mobile.png"
check 'const d=document.querySelector("#profile-create-dialog");if(document.documentElement.scrollWidth>innerWidth||d.scrollWidth>d.clientWidth||d.getBoundingClientRect().bottom>innerHeight)throw Error("create dialog overflow"); "create dialog fits mobile"'
ab fill '#profile-create-id' 'blank-profile'
ab fill '#profile-create-label' 'Blank Profile'
ab click '#profile-create-submit'
ab wait --fn 'location.hash==="#profile/blank-profile"'
check 'if(!document.querySelector("[data-action=pi-thinking]").disabled||!document.querySelector("[data-action=codex-thinking]").disabled)throw Error("blank model inheritance is misleading"); "blank model settings inherit defaults"'
node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1]));if(p.instructions.length||p.skills.length||p.adapters.pi.model||p.adapters.codex.sandbox!=="read-only")throw Error("blank defaults mismatch")' "$ROOT/profiles/blank-profile.json"
ab set viewport 1440 1000
ab select '[data-action="pi-provider"]' 'openai-codex'
ab click '[data-action="sync-codex-model"]'
ab click '[data-action="save-profile"]'
ab click '#confirm-save'
ab wait --fn 'document.querySelector("#inspector")?.textContent.includes("当前无修改")'
node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1]));if(!p.adapters.pi.model?.id||!p.adapters.codex.model?.id)throw Error("blank model editing failed")' "$ROOT/profiles/blank-profile.json"
ab click '.back-link'
ab click '[data-action="delete-profile"][data-profile="custom-copy"]'
check 'if(!document.querySelector("#profile-delete-submit").disabled)throw Error("delete missing typed confirmation"); "delete requires exact ID"'
audit delete-profile
ab fill '#profile-delete-confirm' 'wrong-id'
check 'if(!document.querySelector("#profile-delete-submit").disabled)throw Error("incorrect confirmation accepted"); "incorrect ID rejected"'
ab click '[data-action="cancel-delete-profile"]'
test -e "$ROOT/profiles/custom-copy.json"
ab click '[data-action="delete-profile"][data-profile="custom-copy"]'
node -e 'const fs=require("fs"),p=process.argv[1],v=JSON.parse(fs.readFileSync(p));v.label="External copy edit";fs.writeFileSync(p,JSON.stringify(v))' "$ROOT/profiles/custom-copy.json"
ab fill '#profile-delete-confirm' 'custom-copy'
ab click '#profile-delete-submit'
ab wait --fn 'document.querySelector("#app").getAttribute("aria-busy")==="false"'
check 'if(!document.querySelector("#profile-delete-error").textContent.includes("其他管理器")||!document.querySelector("#profile-delete-submit").disabled)throw Error("delete conflict not blocked"); "delete CAS conflict blocked"'
ab click '[data-action="cancel-delete-profile"]'
ab click '[data-action="delete-profile"][data-profile="custom-copy"]'
ab fill '#profile-delete-confirm' 'custom-copy'
printf 'verify --catalog' > "$ROOT/fail-once"
ab click '#profile-delete-submit'
ab wait --fn 'document.querySelector("#app").getAttribute("aria-busy")==="false"'
test -e "$ROOT/profiles/custom-copy.json"
check 'if(!document.querySelector("#profile-delete-error").textContent.includes("已恢复"))throw Error("delete rollback not reported"); "delete rollback restores source"'
ab click '#profile-delete-submit'
ab wait --fn '!document.querySelector("#profile-delete-dialog").open'
test ! -e "$ROOT/profiles/custom-copy.json"
# A deleted Profile loses only its own local draft; the other drafts survive.
ab fill '[data-action="profile-label"][data-profile="blank-profile"]' 'Discard on deletion'
ab click '[data-action="delete-profile"][data-profile="blank-profile"]'
check 'if(!document.querySelector("#profile-delete-dirty").textContent.includes("未保存"))throw Error("delete hid unsaved impact"); "deletion explains draft loss"'
ab set viewport 390 844
ab screenshot "$EVIDENCE/delete-profile-mobile.png"
ab fill '#profile-delete-confirm' 'blank-profile'
ab click '#profile-delete-submit'
ab wait --fn '!document.querySelector("#profile-delete-dialog").open'
check 'if([...Object.keys(localStorage)].some(k=>k.endsWith(":blank-profile"))||!document.querySelector(`[data-route="profile/heavy"] .change-count`))throw Error("delete draft cleanup affected wrong Profile");if(document.activeElement===document.body)throw Error("deletion lost focus"); "deleted draft removed; other draft and focus retained"'
ab set viewport 1440 1000
ab screenshot "$EVIDENCE/configurations-lifecycle-desktop.png"
audit profile-management
ab errors --json > "$EVIDENCE/browser-errors.json"
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1])).data;if(d.errors.length)throw Error(JSON.stringify(d.errors))' "$EVIDENCE/browser-errors.json"
ab console > "$EVIDENCE/browser-console.txt"
ab snapshot -i > "$EVIDENCE/final-snapshot.txt"
printf 'Browser fixture PASS\n' > "$EVIDENCE/result.txt"
