#!/usr/bin/env bash
# Isolated fixture only: batch edits drafts until the explicit review/save action.
set -euo pipefail
STATE=${1:?fixture state JSON}; EVIDENCE=${2:?evidence directory}
command -v node >/dev/null; command -v npx >/dev/null
mkdir -p "$EVIDENCE"
ROOT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).root)' "$STATE")
URL=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).url)' "$STATE")
case "$ROOT" in */harness-web-*) ;; *) exit 2;; esac
ab() { npx --yes agent-browser@0.38.2 --session "${AGENT_BROWSER_SESSION:-harness-skill-selection-qa}" "$@"; }
check() { printf '(() => {\n%s\n})()\n' "$1" | ab eval --stdin; }
audit() { ab a11y --json > "$EVIDENCE/$1-a11y.json"; node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1])).data;if(d.counts.violations)throw Error(JSON.stringify(d.violations));' "$EVIDENCE/$1-a11y.json"; }
ab open "$URL"
ab click '#primary-nav [data-route="skills"]'
ab wait --fn 'document.querySelector(`[data-action="skill-target-profile"]`) !== null'
check 'if(!document.querySelector(`[data-action="bulk-skills"]`).disabled)throw Error("browse-only unexpectedly changes a profile");"Explicit target required"'
ab select '[data-action="skill-target-profile"]' 'medium'
ab fill '[data-action="skill-search"]' '飞书'
check 'if(document.querySelectorAll(".skill-row").length!==3||[...document.querySelectorAll(".skill-row strong")].some(el=>!el.textContent.startsWith("lark-")))throw Error("Chinese tag search misses lark docs/wiki");"All Feishu skills searchable by tag"'
ab click '[data-action="bulk-skills"][data-mode="enable"]'
check 'if([...document.querySelectorAll(`[data-action="toggle-skill"]`)].some(el=>!el.checked)||!document.querySelector(`[data-action="save-profile"]`))throw Error("batch enable missing");"Feishu batch draft ready"'
node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1]+"/profiles/medium.json"));if(JSON.stringify(v.skills)!==JSON.stringify(["short-skill"]))throw Error("draft wrote source before save")' "$ROOT"
ab select '[data-action="skill-status"]' 'off'
check 'if(document.querySelectorAll(".skill-row").length||!document.querySelector(`[data-action="bulk-skills"][data-mode="enable"]`).disabled)throw Error("status/empty results wrong");"Selected status filter and empty actions safe"'
ab click '[data-action="clear-skill-filters"]'
check 'const hidden=document.querySelector(`[data-action="toggle-skill"][data-name="short-skill"]`);if(!hidden.checked)throw Error("hidden prior selection lost");"Batch preserved unrelated selections"'
ab click '[data-action="skill-category"][data-category="飞书"]'
ab click '[data-action="bulk-skills"][data-mode="disable"]'
check 'if([...document.querySelectorAll(`[data-action="toggle-skill"]`)].some(el=>el.checked))throw Error("batch deselect failed");"Feishu-only deselection"'
ab click '[data-action="undo-profile"]'
check 'if([...document.querySelectorAll(`[data-action="toggle-skill"]`)].some(el=>!el.checked))throw Error("single batch undo failed");"Undo restores whole batch"'
ab reload
ab wait --fn 'document.querySelector(`[data-action="skill-target-profile"]`) !== null'
ab select '[data-action="skill-target-profile"]' 'medium'
ab click '[data-action="skill-category"][data-category="飞书"]'
check 'if([...document.querySelectorAll(`[data-action="toggle-skill"]`)].some(el=>!el.checked))throw Error("draft lost on reload");"Batch draft survives reload"'
audit skills-desktop
ab screenshot --full "$EVIDENCE/skills-desktop.png"
ab set viewport 375 812
check 'if(document.documentElement.scrollWidth>window.innerWidth+1)throw Error("mobile overflow");"Mobile filters contained"'
audit skills-mobile
ab screenshot --full "$EVIDENCE/skills-mobile.png"
ab click '[data-action="save-profile"]'
ab wait --fn 'document.querySelector("#confirm-dialog").open'
check 'if(!document.querySelector("#confirm-body").textContent.includes("lark-doc"))throw Error("review omits batch additions");"Explicit review includes batch"'
ab click '#confirm-save'
ab wait --fn 'document.querySelector(`[data-action="save-profile"]`)?.disabled && document.querySelector("#app").getAttribute("aria-busy") !== "true"'
node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1]+"/profiles/medium.json"));for(const name of ["short-skill","lark-doc","lark-wiki","lark-im"])if(!v.skills.includes(name))throw Error("save dropped "+name);const h=JSON.parse(require("fs").readFileSync(process.argv[1]+"/profiles/heavy.json"));if(JSON.stringify(h.skills)!==JSON.stringify(["long-skill"]))throw Error("other profile changed")' "$ROOT"
ab set viewport 1280 720
ab click '[data-route="profile/medium"]'
ab click '[data-action="go-section"][data-section="skills"]'
ab fill '[data-action="skill-search"]' 'lark wiki'
check 'if(document.querySelectorAll("#section-skills .skill-row").length!==1)throw Error("profile search does not share term intersection");"Profile and catalog share filtering"'
ab errors --json > "$EVIDENCE/browser-errors.json"
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1])).data;if(d.errors.length)throw Error(JSON.stringify(d.errors));' "$EVIDENCE/browser-errors.json"
printf 'Skill selection browser PASS\n' | tee "$EVIDENCE/result.txt"
