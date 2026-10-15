#!/usr/bin/env bash
# Real browser checks against disposable Engine/Catalog Git clones; never uses installed credentials.
set -euo pipefail
STATE=${1:?fixture state JSON required}
EVIDENCE=${2:?external evidence directory required}
command -v node >/dev/null
command -v npx >/dev/null
command -v git >/dev/null
mkdir -p "$EVIDENCE"
field() { node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1]))[process.argv[2]])' "$STATE" "$1"; }
ROOT=$(field root); ENGINE=$(field engine); SOURCE=$(field source); REPO=$(field repo); URL=$(field url)
case "$ROOT" in */harness-engine-updates-*) ;; *) echo "Not a disposable Engine fixture" >&2; exit 2;; esac
case "$REPO" in */harness-sync-web-*/catalog) ;; *) echo "Not a disposable Catalog fixture" >&2; exit 2;; esac
export AGENT_BROWSER_SESSION=${AGENT_BROWSER_SESSION:-harness-engine-updates-qa}
ab() { npx --yes agent-browser@0.38.2 "$@"; }
trap 'ab close >/dev/null 2>&1 || true' EXIT
check() { printf '(() => {\n%s\n})()\n' "$1" | ab eval --stdin; }
audit() {
  ab a11y --json > "$EVIDENCE/$1-a11y.json"
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1])).data;if(d.counts.violations)throw Error(JSON.stringify(d.violations));console.log("axe violations=0, manual-review="+d.counts.incomplete)' "$EVIDENCE/$1-a11y.json"
}
BEFORE=$(git -C "$ENGINE" rev-parse HEAD)
CATALOG_BEFORE=$(git -C "$REPO" rev-parse HEAD)
REMOTE=$(git -C "$SOURCE" rev-parse HEAD)
ab open "$URL"
ab click '#primary-nav [data-route="sync"]'
ab wait --fn 'document.querySelector(`[data-action="engine-check"]`)?.disabled === false'
check 'if(document.querySelector(`[data-action="engine-auto"]`).checked||!document.querySelector("#engine-update-indicator").hidden)throw Error("automatic app check was opted in");if(!document.querySelector(`[aria-label="应用新版本检测"]`).textContent.includes("尚未获取"))throw Error("startup fetched app versions");"Default startup stays offline"'
if test -n "$(git -C "$ENGINE" for-each-ref refs/harness/engine-updates)"; then echo "Startup fetched Engine" >&2; exit 1; fi
ab click '[data-action="engine-check"]'
ab wait --fn '!document.querySelector("#engine-update-indicator").hidden && !document.querySelector(`[data-action="engine-check"]`).disabled'
check 'if(document.querySelector("#engine-update-indicator").textContent!=="应用有新版本"||!document.querySelector("#catalog-update-indicator").hidden)throw Error("app and Catalog indicators conflated");if(!document.querySelector(`[aria-label="应用新版本检测"]`).textContent.includes("0.2.0"))throw Error("new version not shown");"App version detected separately without applying"'
audit engine-updates-desktop
ab screenshot --full "$EVIDENCE/engine-updates-desktop.png"
ab check '[data-action="engine-auto"]'
ab wait --fn 'document.querySelector(`[data-action="engine-auto"]`).checked && !document.querySelector(`[data-action="engine-check"]`).disabled'
ab reload
ab wait --fn 'document.querySelector(`[data-action="engine-auto"]`)?.checked && !document.querySelector(`[data-action="engine-check"]`).disabled'
ab uncheck '[data-action="engine-auto"]'
ab wait --fn '!document.querySelector(`[data-action="engine-auto"]`).checked && !document.querySelector(`[data-action="engine-check"]`).disabled'
ab reload
ab wait --fn 'document.querySelector(`[data-action="engine-auto"]`)?.checked === false && !document.querySelector(`[data-action="engine-check"]`).disabled'
# Missing remote branch must not make the cached successful result appear fresh/current.
git -C "$SOURCE" -c core.hooksPath=/dev/null update-ref -d refs/heads/main
ab click '[data-action="engine-check"]'
ab wait --fn 'document.querySelector("#engine-update-indicator").textContent === "应用版本检查失败"'
check 'if(!document.querySelector(`[aria-label="应用新版本检测"]`).textContent.includes("上次成功"))throw Error("failed fetch hid stale status");"Failure keeps timestamped stale result, not false success"'
ab set viewport 375 812
check 'if(document.documentElement.scrollWidth>window.innerWidth+1)throw Error("mobile overflow");"Mobile layout contained"'
audit engine-updates-mobile
ab screenshot --full "$EVIDENCE/engine-updates-mobile.png"
git -C "$SOURCE" -c core.hooksPath=/dev/null update-ref refs/heads/main "$REMOTE"
ab click '[data-action="engine-check"]'
ab wait --fn 'document.querySelector("#engine-update-indicator").textContent === "应用有新版本" && !document.querySelector(`[data-action="engine-check"]`).disabled'
check 'if(document.querySelector(`[aria-label="应用新版本检测"] [role="alert"]`).textContent)throw Error("recovery kept old error");"Manual retry recovers"'
if test "$(git -C "$ENGINE" rev-parse HEAD)" != "$BEFORE" || test "$(git -C "$REPO" rev-parse HEAD)" != "$CATALOG_BEFORE"; then echo "Detection changed source HEAD" >&2; exit 1; fi
if test -e "$REPO/calls.log" || test -e "$ENGINE/never-install"; then echo "Remote/Catalog code executed" >&2; exit 1; fi
ab errors --json > "$EVIDENCE/browser-errors.json"
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1])).data;if(d.errors.length)throw Error(JSON.stringify(d.errors));' "$EVIDENCE/browser-errors.json"
printf 'Engine updates browser PASS\n' | tee "$EVIDENCE/result.txt"
