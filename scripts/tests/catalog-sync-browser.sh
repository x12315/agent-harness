#!/usr/bin/env bash
# Real UI against a disposable Git Catalog; never the installed Catalog or authentication.
set -euo pipefail
STATE=${1:?fixture state JSON required}
EVIDENCE=${2:?external evidence directory required}
command -v node >/dev/null
command -v npx >/dev/null
mkdir -p "$EVIDENCE"
field() { node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1]))[process.argv[2]])' "$STATE" "$1"; }
ROOT=$(field root); REPO=$(field repo); SOURCE=$(field source); HOME_FIXTURE=$(field home); URL=$(field url)
case "$ROOT" in */harness-sync-web-*) ;; *) echo 'Not a disposable sync fixture' >&2; exit 2;; esac
ab() { npx --yes agent-browser@0.38.2 --session "${AGENT_BROWSER_SESSION:-harness-catalog-sync-qa}" "$@"; }
check() { printf '(() => {\n%s\n})()\n' "$1" | ab eval --stdin; }
audit() {
  ab a11y --json > "$EVIDENCE/$1-a11y.json"
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1])).data;if(d.counts.violations)throw Error(JSON.stringify(d.violations));console.log("axe violations=0, manual-review="+d.counts.incomplete)' "$EVIDENCE/$1-a11y.json"
}
git_fixture() { git -C "$1" -c core.hooksPath=/dev/null "${@:2}"; }
BEFORE=$(git_fixture "$REPO" rev-parse HEAD)
ab open "$URL"
ab click '#primary-nav [data-route="sync"]'
ab wait --fn 'document.querySelector("#catalog-sync-form select")?.options.length === 1'
check 'if(document.querySelector(`#catalog-sync-form [name="automaticCheck"]`).checked||document.querySelector("#catalog-sync-settings").open)throw Error("offline or lightweight default lost");"Offline; Git settings hidden by default"'
audit sync-registration
ab click '#catalog-sync-settings > summary'
ab fill '#catalog-sync-form [name="branch"]' 'main;touch'
ab click '#catalog-sync-form button[type="submit"]'
ab wait --fn 'document.querySelector("#main [role=alert]")?.textContent.includes("合法分支")'
ab fill '#catalog-sync-form [name="branch"]' 'main'
ab check '#catalog-sync-form [name="automaticCheck"]'
ab click '#catalog-sync-form button[type="submit"]'
ab wait --fn 'document.querySelector("#catalog-sync-dialog").open'
check 'const entries=document.querySelector("#catalog-sync-review-entries");if(!entries.textContent.includes("说明文档")||entries.textContent.includes("README.md")||document.querySelector("#catalog-sync-review [data-sync-technical]").open)throw Error("raw Git files replace semantic entries");"Automatic check shows semantic entries, not file approval"'
if test "$(git_fixture "$REPO" rev-parse HEAD)" != "$BEFORE"; then echo 'Automatic check applied source' >&2; exit 1; fi
audit sync-popup
ab click '[data-action="sync-later"]'
ab reload
ab wait --fn 'document.querySelector("#catalog-sync-form [name=automaticCheck]")?.checked'
check 'if(document.querySelector("#catalog-sync-dialog").open)throw Error("same dismissed candidate interrupted reload");"Preference and dismissal persist"'
ab click '[data-action="sync-review"]'
ab set viewport 375 812
check 'if(document.documentElement.scrollWidth>window.innerWidth+1)throw Error("mobile review overflow");"Mobile review contained"'
audit sync-popup-mobile
ab screenshot "$EVIDENCE/sync-update-mobile.png"
ab click '[data-action="sync-apply"]'
ab wait --fn 'document.querySelector("#catalog-sync-result")?.textContent.includes("静态检查：通过") && document.querySelector("#app").getAttribute("aria-busy") !== "true"'
check 'if(!document.querySelector("#catalog-update-indicator").hidden||document.querySelectorAll("#catalog-sync-result [data-sync-phase]").length!==3)throw Error("complete configuration stages missing");"Source + configuration + static verification completed; runtime stays separate"'
node -e 'const f=require("fs");if(!f.existsSync(process.argv[1]+"/.pi/agent/settings.json"))throw Error("Native projection missing");if(f.existsSync(process.argv[2]+"/calls.log"))throw Error("Catalog code ran");' "$HOME_FIXTURE" "$REPO"
audit sync-completed-mobile
ab screenshot --full "$EVIDENCE/sync-completed-mobile.png"
ab set viewport 1280 720
# A second ordinary update should use one button, with no extra confirmation dialog.
node -e 'require("fs").writeFileSync(process.argv[1]+"/README.md","Second one-click fixture update.\n")' "$SOURCE"
git_fixture "$SOURCE" add README.md; git_fixture "$SOURCE" commit -m 'fixture: one-click update'
ab click '[data-action="sync-now"]'
ab wait --fn 'document.querySelector("#catalog-sync-result")?.textContent.includes("静态检查：通过") && document.querySelector("#app").getAttribute("aria-busy") !== "true"'
check 'if(document.querySelector("#catalog-sync-dialog").open)throw Error("safe configuration required a second confirmation");"One-click configuration update passed"'
node -e 'if(require("fs").readFileSync(process.argv[1]+"/README.md","utf8")!=="Second one-click fixture update.\n")throw Error("one-click did not update source")' "$REPO"
# Installer delta is shown by package name and stopped before source changes or downloads.
CURRENT=$(git_fixture "$REPO" rev-parse HEAD)
node -e 'require("fs").writeFileSync(process.argv[1]+"/adapters/pi/settings.json",JSON.stringify({packages:["npm:fixture-install-item@1.2.3"],skills:[]}))' "$SOURCE"
git_fixture "$SOURCE" add adapters/pi/settings.json; git_fixture "$SOURCE" commit -m 'fixture: install declaration review'
ab click '[data-action="sync-now"]'
ab wait --fn 'document.querySelector("#catalog-sync-dialog").open && document.querySelector("#catalog-sync-review [data-sync-installation]")'
check 'if(!document.querySelector("#catalog-sync-apply").disabled||!document.querySelector("#catalog-sync-review").textContent.includes("fixture-install-item")||!document.querySelector("#catalog-sync-review-task").value.includes("固定版本"))throw Error("installer review/handoff missing");"Installer named, blocked, readonly task includes fixed official tools"'
if test "$(git_fixture "$REPO" rev-parse HEAD)" != "$CURRENT"; then echo 'Installer delta fast-forwarded source' >&2; exit 1; fi
test ! -e "$HOME_FIXTURE/.pi/agent/npm"
audit sync-install-review
ab screenshot "$EVIDENCE/sync-install-review.png"
ab click '[data-action="sync-later"]'
ab click '#primary-nav [data-route="compare"]'
ab fill '[data-action="profile-label"][data-profile="medium"]' 'Preserved local browser draft'
ab click '#primary-nav [data-route="sync"]'
check 'if(!document.querySelector(`[data-action="sync-now"]`).disabled||!document.querySelector(`[data-action="sync-review"]`).disabled)throw Error("draft did not block sync");"Unsaved draft blocks source/config apply"'
audit sync-completed-desktop
ab screenshot --full "$EVIDENCE/sync-completed-desktop.png"
ab errors --json > "$EVIDENCE/browser-errors.json"
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1])).data;if(d.errors.length)throw Error(JSON.stringify(d.errors));' "$EVIDENCE/browser-errors.json"
printf 'Catalog lightweight sync browser PASS\n' | tee "$EVIDENCE/result.txt"
