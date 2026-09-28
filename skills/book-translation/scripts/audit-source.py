#!/usr/bin/env python3
"""Pre-flight audit of a source PDF before translating it.

Answers the one question that decides whether the translation will be usable:
is the text layer intact, or was this PDF re-exported in a way that stripped
the font Unicode maps?

Run:
    uv run --with pymupdf --python 3.12 audit-source.py book.pdf
"""

import re
import sys
from collections import Counter

import pymupdf

# Characters Computer Modern (LaTeX) fonts decode into when a re-export drops
# the ToUnicode table. Observed: theta -> checkmark, pi -> up arrow,
# times -> rightwards arrow, asterisk -> leftwards arrow.
SUSPECT = "✓⇡⇥⇤\ufffd"

# Characters that should appear in any maths-adjacent document whose text
# layer is healthy.
MATH = "θαβγωπ∈×∗≤≥≈√∑∏∂⟨⟩∥"

# Fonts whose presence plus zero MATH characters means the map was stripped.
CM_FONT = re.compile(r"CMMI|CMSY|CMR|CMBX|CMSS|CMTI|LMMath|MSAM|MSBM")


def audit(path: str) -> int:
    doc = pymupdf.open(path)
    meta = doc.metadata or {}
    pages = len(doc)

    # Sample evenly across the body, skipping front matter.
    lo, hi = int(pages * 0.15), max(int(pages * 0.9), 1)
    step = max((hi - lo) // 40, 1)
    sample = list(range(lo, hi, step))[:40]

    text = "".join(doc[i].get_text() for i in sample)
    chars = len(text)
    words = len(text.split())

    suspect = Counter(c for c in text if c in SUSPECT)
    math = Counter(c for c in text if c in MATH)

    fonts = set()
    for i in sample[:8]:
        for f in doc[i].get_fonts(full=True):
            fonts.add(re.sub(r"^[A-Z]{6}\+", "", f[3]))

    has_cm = any(CM_FONT.search(f) for f in fonts)
    math_n = sum(math.values())
    suspect_n = sum(suspect.values())

    print(f"file       {path}")
    print(f"pages      {pages}")
    print(f"producer   {meta.get('producer') or '-'}")
    print(f"creator    {meta.get('creator') or '-'}")
    print(f"created    {(meta.get('creationDate') or '-')[:20]}")
    print(f"text       {chars:,} chars / {words:,} words over {len(sample)} sampled pages")
    print(f"fonts      {', '.join(sorted(fonts)[:6]) or '-'}")
    print(f"math chars {math_n}" + (f"  {dict(math.most_common(6))}" if math_n else ""))
    print(f"suspect    {suspect_n}" + (f"  {dict(suspect.most_common(6))}" if suspect_n else ""))

    if chars < 200:
        print("token est  n/a (no text layer - scanned document, OCR required)")
        print("verdict    SCANNED - run OCR first (mineru, or --auto-enable-ocr-workaround)")
        return 1

    tokens = chars / len(sample) * pages / 4
    print(f"token est  ~{tokens:,.0f} input / ~{tokens * 0.7:,.0f} output tokens (whole book)")

    # A healthy document decodes maths and never emits the mis-mapped symbols.
    # A re-exported one is the reverse: suspect symbols dominate what little
    # maths survives (typically only the glyphs outside the damaged fonts).
    if suspect_n > 20 and suspect_n > 2 * math_n:
        print("verdict    BROKEN - text layer is corrupted; find a clean copy")
        return 1
    if has_cm and suspect_n > 20:
        print("verdict    BROKEN - Computer Modern fonts decoding to wrong symbols")
        return 1
    if not math_n:
        print("verdict    OK (no maths in sample - cannot confirm symbol decoding)")
        return 0
    print("verdict    OK - text layer decodes maths correctly")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    sys.exit(audit(sys.argv[1]))
