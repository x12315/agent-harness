#!/usr/bin/env python3
"""Post-flight check on a translated PDF: did the whole book actually translate?

Catches the two silent failures that look like success:
  - pages the translator skipped, leaving the source language in place
  - a text layer that stayed in the source language's symbol set, so the
    output renders correctly but cannot be searched or copied

Run:
    uv run --with pymupdf --python 3.12 verify-translation.py book.zh.mono.pdf
"""

import re
import sys

import pymupdf

CJK = re.compile(r"[\u4e00-\u9fff]")
SUSPECT = "✓⇡⇥⇤\ufffd"
MATH = "θαβγωπ∈×∗≤≥≈√∑∏∂⟨⟩∥"


def verify(path: str, needle: str = "") -> int:
    doc = pymupdf.open(path)
    pages = len(doc)
    with_target = 0
    blank = 0
    source_left = []

    for i in range(pages):
        text = doc[i].get_text()
        if not text.strip():
            blank += 1
            continue
        if CJK.search(text):
            with_target += 1
        elif len(text.strip()) > 200:
            source_left.append(i + 1)

    whole = "".join(doc[i].get_text() for i in range(0, pages, max(pages // 30, 1)))
    suspect = sum(whole.count(c) for c in SUSPECT)
    math = {c: whole.count(c) for c in MATH if whole.count(c)}

    print(f"file       {path}")
    print(f"pages      {pages}")
    print(f"translated {with_target} pages ({100 * with_target / pages:.1f}%)")
    print(f"source-only {len(source_left)} pages" + (f"  e.g. {source_left[:8]}" if source_left else ""))
    print(f"blank      {blank} pages")
    print(f"math chars {sum(math.values())}" + (f"  {math}" if math else ""))
    print(f"suspect    {suspect}" + ("  <- text layer never decoded" if suspect else ""))

    if needle:
        hits = sum(len(doc[i].search_for(needle)) for i in range(0, pages, max(pages // 20, 1)))
        print(f"search {needle!r} {hits} hits in sampled pages")

    bad = blank or source_left or suspect
    print("verdict    " + ("INCOMPLETE - inspect the pages listed above" if bad else "OK - full coverage"))
    return 1 if bad else 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    sys.exit(verify(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else ""))
