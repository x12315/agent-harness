#!/usr/bin/env python3
"""Render pi session labels as clickable file:// links to an HTML snapshot.

Usage:
  pi-labels.py [session.jsonl] [--html path] [--out bookmarks.md]

Without arguments it picks the newest session for the current working
directory. It exports the session to HTML (via `pi --export`) and prints one
markdown line per label:

  - [label](file:///.../session.html?leafId=<entryId>&targetId=<entryId>)
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def sessions_dir(cwd: Path) -> Path:
    key = str(cwd).lstrip("/").replace("/", "-").replace("\\", "-").replace(":", "-")
    return Path.home() / ".pi" / "agent" / "sessions" / f"--{key}--"


def newest_session(cwd: Path) -> Path:
    files = sorted(sessions_dir(cwd).glob("*.jsonl"), key=lambda p: p.stat().st_mtime)
    if not files:
        sys.exit(f"no sessions found in {sessions_dir(cwd)}")
    return files[-1]


def collect_labels(session: Path) -> list[tuple[str, str]]:
    """Return (label, targetId) pairs, honouring clear-then-reset ordering."""
    order: list[str] = []
    labels: dict[str, str | None] = {}
    for line in session.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if entry.get("type") != "label":
            continue
        target = entry.get("targetId")
        if not target:
            continue
        if target not in labels:
            order.append(target)
        labels[target] = entry.get("label") or None
    return [(labels[t], t) for t in order if labels[t]]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("session", nargs="?", help="session .jsonl (default: newest in cwd)")
    ap.add_argument("--html", help="HTML snapshot path (default: next to the session)")
    ap.add_argument("--out", help="append markdown links to this file instead of stdout")
    ap.add_argument("--no-export", action="store_true", help="reuse the existing HTML snapshot")
    args = ap.parse_args()

    session = Path(args.session).expanduser() if args.session else newest_session(Path.cwd())
    html = Path(args.html).expanduser() if args.html else session.with_suffix(".html")

    if not args.no_export:
        subprocess.run(["pi", "--export", str(session), str(html)], check=True)

    base = html.resolve().as_uri()
    labels = collect_labels(session)

    lines = [
        # leafId pins the viewer to the labelled entry so the deep link always
        # scrolls, even when the label sits on an abandoned branch.
        f"- [{label}]({base}?leafId={target}&targetId={target})"
        for label, target in labels
    ]

    if not labels:
        print("no labels in this session", file=sys.stderr)

    text = "\n".join(lines)
    if args.out:
        with Path(args.out).expanduser().open("a", encoding="utf-8") as fh:
            fh.write(text + "\n")
        print(f"appended {len(lines)} link(s) to {args.out}", file=sys.stderr)
    else:
        print(text)
    print(f"snapshot: {html}", file=sys.stderr)


if __name__ == "__main__":
    main()
