---
name: book-translation
description: Translates a whole book, textbook, paper, or long PDF/EPUB into another language with pdf2zh-next, preserving formulas, pseudocode, and page layout, then verifies coverage. Use when asked to translate a book or long PDF, when a translated or bilingual PDF is wanted, or when a PDF translator produced garbled, broken, or untranslated output.
---

# Book translation

`pdf2zh-next` (BabelDOC driving an LLM) emits a translated PDF plus a
bilingual one. Two things break a run: a **damaged source** and a
**misconfigured engine**. Steps 1–2 settle both before spending money;
steps 4–5 prove the result is complete.

## 1. Audit the source

```bash
uv run --with pymupdf --python 3.12 scripts/audit-source.py book.pdf
```

Read two numbers: `math chars` (maths the text layer decodes) and `suspect`
(characters a damaged layer emits instead). A healthy book decodes maths and
never emits suspects; a re-exported one inverts that.

- `OK` → continue.
- `BROKEN` → get a clean copy (§2) and re-audit. Translating a broken source
  still costs full price, and yields a PDF whose formulas cannot be searched,
  copied, or reliably translated.
- `SCANNED` → no text layer at all; OCR before translating.

**Done when** the audit exits 0 with the source's maths decoding correctly.

## 2. Get a clean copy

The usual cause of `BROKEN` is a re-export. Consumer viewers (macOS Preview,
some print-to-PDF paths) rewrite embedded fonts and drop the Unicode maps
LaTeX wrote. The `producer` line identifies it: `pdfTeX-1.x` is original;
`Quartz PDFContext`, `Preview`, `Skia`, `Acrobat Distiller` are re-exports.

Prefer, in order:

1. the author's or publisher's own download page,
2. any other original export,
3. the re-export you already have — only once the audit passes.

A page's download list may still serve an **older revision** at a path it no
longer advertises. Compare `pages` and `created` from the audit against the
page's own description, and take the newest the page actually links.

**Done when** the audit reports `OK`.

## 3. Configure the engine

The active config is **not** `~/.config/pdf2zh/default/<version>.toml` — that
is the version-migration file, and edits there do nothing. Print the real one:

```bash
$(uv tool dir)/pdf2zh-next/bin/python \
  -c "from pdf2zh_next.const import DEFAULT_CONFIG_FILE as f; print(f)"
# -> ~/.config/pdf2zh/config.v3.toml
```

Put the key under `[deepseek_detail]`, then `chmod 600` the file. CLI flags
override it, and environment variables prefixed `PDF2ZH_` sit in between.

### The thinking-mode trap

The DeepSeek preset forwards the `thinking` parameter **only when the model
name starts with `deepseek-v4-`**. DeepSeek's current names are
`deepseek-flash` and `deepseek-v4-pro`, so the obvious invocation silently
loses the setting:

| model | `--deepseek-thinking-mode disabled` | completion tokens |
|---|---|---|
| `deepseek-flash` | dropped — thinking stays on | 132 |
| `deepseek-v4-flash` | applied | **9** |

Measured on a single sentence: **14.7× the output tokens** for identical text.
`deepseek-v4-flash` matches the prefix check, and DeepSeek still honours the
legal name at Flash pricing.

Confirm it landed by comparing the reported `Completion` count against the
paragraph count of a small run — tens of tokens per paragraph means thinking
is off.

### Choosing one

| engine | cost | maths and pseudocode | notes |
|---|---|---|---|
| `deepseek-v4-flash` | lowest | good | default choice |
| `deepseek-v4-pro` | ~4× | stronger prose | reach for it when the flash output reads thin |
| `siliconflowfree` | free, no key | fair | times out partway through a long book |
| `bing` / `google` | free, no key | poor — splits line numbers, emails, inline formulas | smoke tests only |

Reference point: a 644-page maths textbook cost **¥4.96** and 8 minutes at
`--qps 16`.

**Done when** the config file holds the key and the model name matches the
prefix check above.

## 4. Run

```bash
mkdir -p out      # pdf2zh-next creates it; pdf2zh 1.9.x crashes without it
nohup pdf2zh --deepseek --lang-in en --lang-out zh \
  --save-auto-extracted-glossary \
  --qps 16 --pool-max-workers 16 \
  book.pdf --output out > run.log 2>&1 &
```

Launch it detached: a full book takes minutes to hours, and the log runs long.
Translation results are cached by content, so a re-run after an interruption
resumes rather than re-paying.

Leave `--max-pages-per-part` off. It splits the document, and each part
extracts its own glossary, which costs cross-chapter term consistency — the
thing that matters most in a textbook.

**Done when** the log shows `Save PDF (1/1)`.

## 5. Verify

```bash
uv run --with pymupdf --python 3.12 \
  scripts/verify-translation.py out/book.zh.mono.pdf θ
```

Pass condition: `translated` equals `pages`, and `source-only`, `blank` and
`suspect` are all 0. A non-zero `search` count confirms the maths stayed
searchable rather than merely rendering.

**Done when** the verifier exits 0.

## 6. Deliver

`pdf2zh-next` writes three files per book: `*.zh.mono.pdf` (translated),
`*.zh.dual.pdf` (bilingual, same-page pairs), `*.zh.glossary.csv`
(auto-extracted terms — worth keeping, and worth hand-correcting before
translating a sequel in the same field).

Name the source and translation as a matched pair, and keep them together.
Move the bilingual copy and glossary somewhere deliberate rather than leaving
them beside the deliverables.

When something in the run looks wrong, see
[references/traps.md](references/traps.md) — it catalogues the failure
signatures that look alarming but are not, and the ones that are.
