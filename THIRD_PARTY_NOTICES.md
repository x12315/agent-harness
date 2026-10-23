# Third-party notices

## Pi example extensions

`adapters/pi/extensions/handoff.ts` and the upstream-derived portions of
`adapters/pi/extensions/subagent/index.ts` and `agents.ts` originate from the
Pi coding-agent examples, with local modifications.

- Upstream: https://github.com/earendil-works/pi
- License: MIT
- Copyright (c) 2025 Mario Zechner

The upstream MIT permission and warranty notice is reproduced in `LICENSE`.
Local modifications are also MIT-licensed. The original monolith history
contains earlier copies of these examples and Pi-derived agent definitions
and prompt templates; their upstream attribution is retained by this notice.

## Coordinator Markdown component

The coordinator UI reuses Marked 18.0.11 (MIT), compiled with esbuild 0.28.2
(MIT), from the installed, version-checked Web UI runtime. Third-party source
and compiled bundles are not vendored in this repository. The private plugin
build retains the Marked banner and copies its full upstream LICENSE alongside
the generated browser module.

- Marked: https://github.com/markedjs/marked
- esbuild: https://github.com/evanw/esbuild

## Runtime dependencies

Pi, Codex, npm packages and installed third-party Skills are separate projects
with their own licenses. This repository's MIT license does not replace those
terms or grant rights to third-party services, models or credentials.
