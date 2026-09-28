# Failure catalogue

Signatures that look alarming but are not, then the ones that are. Sourced
from a 644-page maths textbook translated end to end.

## Alarming, but normal

### `Translation result is the same as input, fallback.`

BabelDOC compares the model's output to the trimmed input; on a match with
more than 10 input tokens it discards the result and retries with a simpler
prompt (`babeldoc/.../il_translator_llm_only.py`, the `same_as_input` branch).

It is a **retry**, not a failure. A handful per hundred paragraphs is healthy.
Formula-heavy paragraphs echo legitimately — the "translation" of an equation
*is* the equation. Escalate only when it dominates the log, which means the
model is not following the placeholder instructions; try `deepseek-v4-pro`.

### `Too many placeholders (N) in paragraph[...], disabling rich text translation`

Inline formulas become placeholder tokens. Past 40 in one paragraph BabelDOC
drops rich-text translation for that paragraph and re-renders it plainly.
Expected in any maths-dense book; the paragraph still translates.

### `Translate process did not finish in time, terminate it`

The parent closes the progress pipe, then joins the worker with
`join(timeout=2)`. A worker still tidying up after `Save PDF` gets SIGTERM'd,
surfacing as `SubprocessCrashError('... exit code -15')`.

The PDFs are already on disk — check the log for `Save PDF (1/1)` and verify
the output rather than re-running blind.

### `ERROR during automatic terms extract: Expecting ',' delimiter`

The glossary agent returned malformed JSON, usually because the model was
asked to emit maths expressions as CSV fields. BabelDOC logs and continues,
but the glossary silently shrinks (2 terms on maths pages where a clean run
yields 36).

Check the emitted `*.glossary.csv` is populated. If it is thin, the
translation still stands; supply a hand-written glossary via `--glossaries`
on any follow-up book in the same field.

## Actual failures

### `ImportError: cannot import name 'TextTranslateRequest'`

Only `pdf2zh` (the 1.9.x line). It imports the Tencent SDK at module top level
while declaring `tencentcloud-sdk-python-tmt` unpinned. Tencent **removed that
class in 3.1.129 (2026-07-07)**, so any fresh install crashes on startup —
whether or not Tencent is the chosen engine.

Pin it and reinstall:

```bash
echo 'tencentcloud-sdk-python-tmt==3.1.121' > ~/.config/uv/pdf2zh-overrides.txt
uv tool install pdf2zh --python 3.12 --overrides ~/.config/uv/pdf2zh-overrides.txt --force
```

`pdf2zh-next` imports each engine lazily (`importlib` on the selected engine
only), so this class of breakage cannot reach it. Prefer `pdf2zh-next`.

### `FileNotFoundError: .../book-mono.pdf`

Only `pdf2zh` 1.9.x, which never creates the `-o` directory. `mkdir -p` first.
`pdf2zh-next` creates it.

### `ValueError: DeepSeek API key is required` though the config has it

Two traps stack here:

1. `~/.config/pdf2zh/default/<version>.toml` is the **version-migration**
   file. Editing it changes nothing.
2. Passing `--deepseek` builds a fresh settings object from
   `default_factory`, so the flag path does not read a per-engine section you
   invented.

Write to the file printed by:

```bash
$(uv tool dir)/pdf2zh-next/bin/python \
  -c "from pdf2zh_next.const import DEFAULT_CONFIG_FILE as f; print(f)"
```

### `error: Executable already exists: pdf2zh`

`pdf2zh-next` ships `pdf2zh`, `pdf2zh2` and `pdf2zh_next`. Installing it
alongside the old `pdf2zh` collides on the first name. `uv tool uninstall
pdf2zh` first, or accept `--force` to repoint `pdf2zh` at the new tool.

### `peewee.OperationalError: database is locked`

The translation cache is SQLite. A run that was killed but not reaped still
holds it. Confirm nothing is alive, then retry:

```bash
pgrep -fl "[p]df2zh"
```

### A stream of `429 Too Many Requests` from Google

The free Google endpoint rate-limits aggressively and the client retries with
exponential backoff, so the run looks hung while making no progress (159
consecutive 429s observed). Use it for smoke tests only, or `--bing`.

## Damaged source PDFs

LaTeX embeds Computer Modern as Type1 fonts whose glyph codes are not Unicode.
The mapping is carried by a `ToUnicode` table. Re-exporting through a consumer
viewer can drop it, after which the text layer decodes to the wrong
characters:

| real | decoded as |
|---|---|
| θ | `✓` |
| π | `⇡` |
| × | `⇥` |
| ∗ | `⇤` |
| ∈ | `2` |
| ≠ | `6=` |

Three consequences, in increasing order of how easy they are to miss:

1. **Inline formulas mistranslate.** The model receives `✓` where `θ` belongs
   and mangles formulas anchored to it — observed collapsing
   `ṡtest = (ṡhigh + ṡlow)/2` into eight fragments and reducing `(slim, ṡtest)`
   to `(,)`.
2. **Layout drifts.** Matrix rows collapse (`cos θ  p1` becomes `cos θp1`,
   changing the meaning; a trailing `0 0 1` row splits across three lines).
3. **Search and copy break.** BabelDOC preserves the original glyphs, so the
   *rendering* looks correct — pixel comparison of a formula region against
   the source is byte-identical — while the text layer stays garbage. Searching
   `θ` returns 0 hits; `✓` returns 5. Copy-paste yields the wrong characters.

Consequence 3 is why a visual spot-check passes a broken book. The audit in
step 1 and the `search` check in step 5 are what catch it.

## Cost arithmetic

Estimate from the audit's token line, then apply the provider's rates:

```
cost = input_tokens × input_rate + output_tokens × output_rate
```

Split observed across a full 644-page book: **2.56M prompt / 0.69M completion**,
roughly 79% / 21%, with the glossary injected into every request. Add ~1.5–2× to
the audit's raw estimate to cover the glossary agent's own calls and retries,
which the per-page text volume does not include.

DeepSeek bills off-peak at half rate; off-peak is all of Saturday and Sunday,
plus any weekday outside 01:00–04:00 and 06:00–10:00 UTC. The measured
644-page run came in at 3.25M tokens / ¥4.96.

## Reading the run

Token usage, in the log after completion:

```bash
perl -0777 -pe 's/\s+/ /g' run.log \
  | grep -oE 'Total Token Usage: Total [0-9]+, Prompt [0-9]+, Cache Hit Prompt [0-9]+, Completion [0-9]+'
```

Cache growth is the throughput signal the progress bars cannot give when
stdout is not a TTY:

```bash
sqlite3 ~/.cache/pdf2zh/cache.v1.db 'select count(*) from _translationcache'
```

Log progress: `Automatic Term Extraction` → `Translate Paragraphs` →
`Generate drawing instructions` → `Save PDF`. `rich` wraps every line to a
narrow width, so collapse whitespace across the whole file before grepping
(`-0777` slurps it; without it `perl -pe` cannot see across line breaks):

```bash
perl -0777 -pe 's/\s+/ /g' run.log | grep -oE 'Save PDF \([0-9]+/[0-9]+\)'
```

## Non-PDF sources

EPUB and HTML are better inputs than PDF when a book offers them: code blocks
and maths separate cleanly, and reflowable output survives on a reader. That
path is not `pdf2zh-next` — use Calibre's Ebook Translator plugin, or
`bilingual_book_maker` / `TranslateBooksWithLLMs` for chapter-level control
with a reusable glossary.
