#!/usr/bin/env bash
# Real UI against the disposable Git Catalog; never run against an installed Catalog.
set -euo pipefail
STATE=${1:?fixture state JSON required}
EVIDENCE=${2:?external evidence directory required}
command -v node >/dev/null
command -v npx >/dev/null
mkdir -p "$EVIDENCE"
ROOT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).root)' "$STATE")
REPO=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).repo)' "$STATE")
URL=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).url)' "$STATE")
case "$ROOT" in */harness-sync-web-*) ;; *) echo "Not a disposable sync fixture" >&2; exit 2;; esac
ab() { npx --yes agent-browser@0.38.2 --session "${AGENT_BROWSER_SESSION:-harness-catalog-sync-qa}" "$@"; }
check() { printf '(() => {\n%s\n})()\n' "$1" | ab eval --stdin; }
audit() {
  ab a11y --json > "$EVIDENCE/$1-a11y.json"
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1])).data;if(d.counts.violations)throw Error(JSON.stringify(d.violations));console.log("axe violations=0, manual-review="+d.counts.incomplete)' "$EVIDENCE/$1-a11y.json"
}
BEFORE=$(git -C "$REPO" rev-parse HEAD)
ab open "$URL"
ab click '#primary-nav [data-route="sync"]'
ab wait --fn 'document.querySelector("#catalog-sync-form select")?.options.length === 1'
check 'if(document.querySelector(`#catalog-sync-form [name="automaticCheck"]`).checked)throw Error("automatic network opted in by default");"No automatic check without registration"'
audit sync-registration
ab fill '#catalog-sync-form [name="branch"]' 'main;touch'
ab click '#catalog-sync-form button[type="submit"]'
ab wait --fn 'document.querySelector("#main [role=alert]")?.textContent.includes("合法分支")'
ab fill '#catalog-sync-form [name="branch"]' 'main'
ab check '#catalog-sync-form [name="automaticCheck"]'
ab click '#catalog-sync-form button[type="submit"]'
ab wait --fn 'document.querySelector("#catalog-sync-dialog").open'
check 'if(!document.querySelector("#catalog-sync-review").textContent.includes("README.md")||!document.querySelector("#catalog-sync-dialog").textContent.includes("不更新工具仓"))throw Error("review scope missing");"Automatic check opened real pinned update review"'
if test "$(git -C "$REPO" rev-parse HEAD)" != "$BEFORE"; then echo "Automatic fetch applied changes" >&2; exit 1; fi
audit sync-popup
ab screenshot "$EVIDENCE/sync-update-popup.png"
ab click '[data-action="sync-later"]'
check 'if(document.querySelector("#catalog-sync-dialog").open||document.querySelector("#catalog-update-indicator").hidden)throw Error("later discarded update indicator");if(!document.activeElement.matches(`[data-route="sync"]`))throw Error("close lost focus");"Later keeps the badge and returns focus"'
ab reload
ab wait --fn '!document.querySelector("#catalog-sync-form button[type=submit]").disabled'
check 'if(document.querySelector("#catalog-sync-dialog").open||!document.querySelector(`#catalog-sync-form [name="automaticCheck"]`).checked)throw Error("dismissal or registration lost on reload");"Registration persisted; same candidate is not repeatedly modal"'
ab click '[data-action="sync-review"]'
ab set viewport 375 812
check 'if(document.documentElement.scrollWidth>window.innerWidth+1)throw Error("mobile popup overflows");"Mobile update popup contained"'
audit sync-popup-mobile
ab screenshot "$EVIDENCE/sync-update-mobile.png"
ab click '[data-action="sync-apply"]'
ab wait --fn 'document.querySelector("#main").textContent.includes("最近同步前快照") && !document.querySelector("#app").getAttribute("aria-busy").includes("true")'
check 'if(!document.querySelector("#catalog-update-indicator").hidden||!document.querySelector("#main").textContent.includes("尚未"))throw Error("applied source state missing");"Source sync completed; activation stays separate"'
node -e 'const f=require("fs");if(f.readFileSync(process.argv[1]+"/README.md","utf8")!=="Remote fixture update: safe configuration only.\n")throw Error("UI sync failed");if(f.existsSync(process.argv[1]+"/calls.log"))throw Error("Catalog code ran");' "$REPO"
audit sync-completed-mobile
ab screenshot --full "$EVIDENCE/sync-completed-mobile.png"
ab set viewport 1280 720
# A local ignored new update must not overwrite the active browser draft.
ab click '#primary-nav [data-route="compare"]'
ab fill '[data-action="profile-label"][data-profile="medium"]' 'Preserved local browser draft'
ab click '#primary-nav [data-route="sync"]'
check 'if(!document.querySelector(`[data-action="sync-review"]`).disabled)throw Error("draft did not block synchronization");"Unsaved draft blocks apply"'
audit sync-completed-desktop
ab screenshot --full "$EVIDENCE/sync-completed-desktop.png"
ab errors --json > "$EVIDENCE/browser-errors.json"
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1])).data;if(d.errors.length)throw Error(JSON.stringify(d.errors));' "$EVIDENCE/browser-errors.json"
printf 'Catalog sync browser PASS\n' | tee "$EVIDENCE/result.txt"
