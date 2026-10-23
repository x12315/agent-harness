# Responsive coordination UI reuse decision

## Requirement

Deliver a directly usable conversation/work workspace without requiring a human to manage task IDs or repeat missing requirements. Preserve the existing Pi execution, model authentication and native supervisor. The user explicitly requested evaluating Graph Engineering or mature open-source components before choosing reuse, improvement or custom implementation.

Earlier Graph Engineering research did not identify a specific repository. We therefore do not claim to have adopted a named Graph Engineering package or infer that a graph editor is required.

## Evaluated paths

| Path | Concrete applicable capability | Boundary/cost | Decision |
| --- | --- | --- | --- |
| Installed Pi Web UI 0.100.0 public plugin SDK, MIT | Native model/agent/goal services, `mount`/`send`/`onData`, topbar and `composer.actions` contributions, settings and lifecycle effects | No public embeddable Chat/Composer or supported replacement of the native send transaction was found. `compose()` fills a native draft, not a durable acknowledgement. Accessing private React roots would be brittle. | Reuse the services and public slots; improve the existing plugin path, never hijack ordinary Enter. |
| assistant-ui `ExternalStoreRuntime`, MIT | External messages + `onNew`, mature thread/composer primitives and Markdown components; does not require migrating the agent backend | Requires React/DOM and a frontend bundle; cannot assume the host exports its React runtime. Durable outbox/workspace/revision/control semantics still need our adapter. A private pinned-package spike hit npm `EIDLETIMEOUT`; offline check confirmed a missing core tarball. No successful build/size or migration-time claim. | A credible future replacement for a richer chat half, not adopted merely for its name. Do not pause the working delivery to rewrite its message transaction. |
| AG-UI + CopilotKit, MIT | Agent UI events/shared state, chat and human interaction components; custom backend supported | Native `coordinator-input/state/accepted/error` is not AG-UI. Requires an adapter for events, run/message identity, reconnection and durable receipt; the state protocol does not replace the task ledger. | No extra protocol/runtime in this delivery. Reconsider at an actual multi-framework UI boundary. |
| React Flow | Node/link graph visualization | This product needs conversation and evidence, not graph editing; adding a graph would not solve intake or completion. | Not included. |
| Installed Marked 18.0.11 + esbuild 0.28.2 | Mature Markdown grammar already available with the exact tested Web UI runtime; safe code/list/table presentation with no additional model or server | Only a small DOM renderer and local compilation are needed. Runtime dependencies are version checked; compiled library + MIT license remain private installation artifacts, not vendored source. | Adopted now. |

## Implemented improvement

The plugin reuses native topbar **and composer action slots** as entries. The standalone page uses the same plugin protocol and authoritative backend, not another application server or task store. Ordinary native chat keeps its existing behavior.

Replies are parsed by Marked, not a home-written Markdown grammar. A small DOM adapter deliberately emits text nodes and safe elements: no raw HTML execution, executable URLs, automatic remote images or untrusted `innerHTML`. Code-copy actions use the native clipboard API only on an explicit click. The existing durable outbox/receipt, natural-language controls, original-goal revisions and domain evidence pane remain ours because generic chat primitives do not implement those contracts.

This chooses **reuse + improvement**, with custom code restricted to the actual coordination contract. It is not a claim that the current view is the best universal chat toolkit.

## Validation obligations

Actual guest Chromium checks desktop/mobile geometry, keyboard/IME behavior, send during held work, reload/exact-once receipt, evidence, targeted controls, and Markdown code/bold rendering with HTML/URL/image safety. Guest cases compile the same version-checked parser as the delivered native launcher. Separately verify real-model work and process outcomes; UI fixture PASS alone is not delivery.

## Primary sources

- Native SDK: https://github.com/xing-shuyin/pi-web-ui/tree/main/plugin-sdk (local API evidence was the installed 0.100.0, not a claim that main is immutable).
- assistant-ui external store: https://www.assistant-ui.com/docs/runtimes/custom/external-store
- assistant-ui package/license: https://github.com/assistant-ui/assistant-ui/tree/main/packages/react
- AG-UI state events: https://docs.ag-ui.com/concepts/state
- CopilotKit custom agent/shared state: https://github.com/CopilotKit/CopilotKit/tree/main/showcase/shell-docs/src/content/docs
- Marked parser/license: https://github.com/markedjs/marked

The component comparison established API fit, not quantified production adoption. The failed optional npm spike is recorded rather than disguised as a successful integration.
