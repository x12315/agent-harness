#!/usr/bin/env bash
# Preference-only real-browser test in isolated HOME/Catalog; never a live default selection.
set -euo pipefail
STATE=${1:?fixture state}; EVIDENCE=${2:?evidence directory}
command -v node >/dev/null; command -v npx >/dev/null
mkdir -p "$EVIDENCE"
ROOT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).root)' "$STATE")
URL=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).url)' "$STATE")
case "$ROOT" in */harness-web-*) ;; *) exit 2;; esac
ab() { npx --yes agent-browser@0.38.2 --session "${AGENT_BROWSER_SESSION:-harness-startup-profile-qa}" "$@"; }
check() { printf '(() => {\n%s\n})()\n' "$1" | ab eval --stdin; }
audit() { ab a11y --json > "$EVIDENCE/$1-a11y.json"; node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1])).data;if(d.counts.violations)throw Error(JSON.stringify(d.violations));' "$EVIDENCE/$1-a11y.json"; }
ab open "$URL"
ab wait --fn '!document.querySelector(`[data-action="startup-profile-choice"]`)?.disabled'
check 'if(document.querySelector(`[data-action="startup-profile-choice"]`).value!==""||!document.querySelector(`[data-action="save-startup-profile"]`).disabled)throw Error("ordinary/read-only initial state missing");"ordinary until explicitly selected"'
ab fill '[data-action="profile-label"][data-profile="heavy"]' 'Unsaved browser label'
ab select '[data-action="startup-profile-choice"]' 'medium'
ab click '[data-action="save-startup-profile"]'
ab wait --fn 'document.querySelector(`[data-action="save-startup-profile"]`)?.disabled && document.querySelector(`[data-action="startup-profile-choice"]`)?.value === "medium"'
check 'if(document.querySelector(`[data-action="profile-label"][data-profile="heavy"]`).value!=="Unsaved browser label"||document.querySelector(`[data-action="save-profile"][data-profile="heavy"]`).disabled)throw Error("preference discarded or saved unrelated draft");"default selection preserves unsaved drafts"'
node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1]+"/profiles/heavy.json"));if(v.label!=="Heavy fixture")throw Error("preference saved unrelated profile");if(require("fs").existsSync(process.argv[1]+"/calls.log"))throw Error("preference ran compose or installer")' "$ROOT"
ab reload
ab wait --fn 'document.querySelector(`[data-action="startup-profile-choice"]`)?.value === "medium" && !document.querySelector(`[data-action="startup-profile-choice"]`).disabled'
check 'if(document.querySelector(`[data-action="profile-label"][data-profile="heavy"]`).value!=="Unsaved browser label")throw Error("draft failed reload recovery");"persisted local default and recovered draft"'
audit startup-desktop
ab screenshot --full "$EVIDENCE/startup-desktop.png"
ab set viewport 375 812
check 'if(document.documentElement.scrollWidth>window.innerWidth+1)throw Error("mobile overflow");"mobile default chooser fits"'
audit startup-mobile
ab screenshot --full "$EVIDENCE/startup-mobile.png"
# Stale another-page snapshot must not overwrite a newer preference.
ab select '[data-action="startup-profile-choice"]' 'ultralight'
check 'return fetch("/api/startup-profile").then(r=>r.json()).then(p=>fetch("/api/startup-profile",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({profile:"heavy",expectedHash:p.preferencesHash})})).then(r=>{if(!r.ok)throw Error("parallel-page fixture update failed");return "newer preference saved separately"})'
ab click '[data-action="save-startup-profile"]'
ab wait --fn 'document.querySelector(`[data-action="startup-profile-choice"]`)?.value === "heavy" && document.querySelector(".error-summary")?.textContent.includes("刷新")'
check 'return fetch("/api/startup-profile").then(r=>r.json()).then(p=>{if(p.profile!=="heavy")throw Error("stale page overwrote current preference");return "conflict preserved newer selection"})'
node -e 'require("fs").unlinkSync(process.argv[1]+"/profiles/heavy.json")' "$ROOT"
ab click '[data-action="reload-startup-profile"]'
ab wait --fn 'document.querySelector("#main").textContent.includes("默认方案已不存在")'
ab select '[data-action="startup-profile-choice"]' ''
ab click '[data-action="save-startup-profile"]'
ab wait --fn 'document.querySelector(`[data-action="save-startup-profile"]`)?.disabled && document.querySelector(`[data-action="startup-profile-choice"]`)?.value === "" && !document.querySelector(".error-summary")'
check 'return fetch("/api/startup-profile").then(r=>r.json()).then(p=>{if(p.profile!==null||p.missing)throw Error("ordinary reset failed");return "missing selection explicitly reset to ordinary"})'
ab errors --json > "$EVIDENCE/browser-errors.json"
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1])).data;if(d.errors.length)throw Error(JSON.stringify(d.errors));' "$EVIDENCE/browser-errors.json"
printf 'Startup preference browser PASS\n' | tee "$EVIDENCE/result.txt"
