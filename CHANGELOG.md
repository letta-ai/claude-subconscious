# Changelog

## [Unreleased]

### Added

- Added per-harness model overrides through `[model_overrides.claude_code]`, `[model_overrides.codex]`, `[model_overrides.letta_code]`, `[model_overrides.hermes]`, and `[model_overrides.opencode]` tables, each accepting `model`, `reasoning_effort`, `context_window_limit`, and provider `settings`. Precedence is harness override, then the project-wide `model`, then the attached agent's default. Values are validated offline, including safe-integer bounds so every accepted number survives a lossless round trip.
- Added a Hermes adapter (`subconscious install hermes`). It observes `on_session_start`, `pre_llm_call` (prompt boundary), `post_tool_call` (tool success/failure from `status`), and `on_session_end` (per-turn stop despite the name). Whispers are delivered only at the next turn's `pre_llm_call` through Hermes' bare `{"context": "..."}` contract — Hermes has no mid-turn context window, so guidance waits for the next turn. Transcript deltas come read-only from the active profile's `state.db` via `node:sqlite`, with the message row id as cursor, explicit 400-row paging, and session-scoped reset when the store is pruned underneath a route. The hook stamps its resolved HERMES_HOME into every payload so a globally shared broker always reads the right profile's store. The installer edits `config.yaml` comment-preserving and idempotently (dedupe per event plus exact command, unrelated hooks untouched, flow-shaped `hooks:` refused rather than corrupted) and seeds exactly the four shell-hook consent allowlist entries without flipping `hooks_auto_accept`; malformed or unreadable allowlists are reported, never overwritten.
- Added an OpenCode adapter (`subconscious install opencode [path]`) tested against OpenCode 1.18.23 and plugin SDK 1.2.27. It installs one project-local generated plugin at `.opencode/plugins/subconscious.js`, refuses conflicting targets it does not own, and is idempotent on rerun. The plugin observes `session.created`, `chat.message`, terminal `message.part.updated` tool parts only when `observer.mid_turn` is enabled, `session.status` on the transition to idle, and `session.deleted` plus server disposal for session end; `tool.execute.after` stays observation-free because it fires before terminal tool state commits. Prompt-boundary passive delivery happens in `chat.message`, which appends one synthetic text part containing the combined status-plus-whisper block and acknowledges only after that append succeeds. `experimental.chat.system.transform` remains the mid-turn channel for whispers produced after the prompt while a turn is already running. Transcript deltas come from the official `client.session.messages` API as a bounded snapshot tail normalized into `key#version` cursor records, so mutable same-ID rewrites replay rather than silently skipping. OpenCode exposes no supported queued-turn path, so `queue_message` stays disabled. A live end-to-end suite proves a resumed OpenCode session receives a seeded whisper on the prompt boundary, and that the observer sees the terminal bash result. Mid-turn `experimental.chat.system.transform` delivery is covered by plugin tests, not that live suite.
- Made the top-level `model` key optional. A file without one inherits the attached agent's default; `subconscious init` without `--model` now writes no model line and creates new observers on `letta/auto`. Both `--model` and `--agent` now require a non-empty value and reject flag-like placeholders.
- A fresh observer conversation is created explicitly with its full override payload before its first turn, and later turns reconcile model, settings, context-window overrides, and reasoning-effort changes onto that same conversation in place, clearing them back to inheritance when the file stops naming them. A model change never forks a route or conversation.
- Route records, session status, and CLI status output now report the requested model, its source (`harness`, `project`, or `agent_default`), the reasoning effort, and the effective backend model for each turn; a turn whose backend reports no model clears the recorded value instead of keeping stale data. Human-readable detail output shows the same decision per route.
- Queued-message delivery sessions carry no model, no reasoning effort, and no dreaming settings, and sends into one observed agent's conversation are serialized so recovery and normal draining cannot race on one record.
- Added `npm run test:model-e2e`, an opt-in live suite that proves the override pipeline against the real Agent SDK: overrides land on a fresh conversation, clearing them restores inheritance in place, and the disposable observer is deleted even on failure.

### Changed

- Replaced the Claude-specific worker with one harness-neutral broker for Claude Code, Codex, Letta Code, Hermes, and OpenCode.
- Replaced `@letta-ai/letta-code-sdk` and direct Letta REST requests with `@letta-ai/letta-agent-sdk`.
- Changed the default observer model to `letta/auto`.
- Added project configuration discovery through the nearest `subconscious.toml` file.
- Added explicit `send_whisper` and capability-gated `queue_message` delivery tools.
- Removed automatic relay of observer assistant text and the `PreToolUse` polling hook.
- Added durable event deduplication, conversation routes, delivery acknowledgements, and ambiguous-send reconciliation state.
- Added OTID lookup and explicit retry or discard controls for interrupted observer turns.
- Moved Subconscious behavior from an agent-wide system prompt into a one-time session primer, followed by transcript-only observations, so any Letta agent can be attached without rewriting its design or repeating instructions every turn.
- Updated to Agent SDK 0.7.6 and kept project model selection scoped to the observer conversation. Session initialization now uses `session.ready()` instead of fetching transcript history.
- Reduced the injected session identity to one compact XML element.

### Fixed

- OpenCode now keys its snapshot cursor as `key#version` rather than key alone, so mutable same-ID transcript rewrites trigger bounded-tail replay instead of reading as unchanged.
- Generated OpenCode snapshot fetch failures now surface to the adapter as `snapshot_error`, generated bridge `projectFacts()` is reread on each eligible terminal tool boundary, and generated child-bridge stdin closure no longer leaves requests hanging until timeout.
- Kept direct Letta Code `queue_message` sessions open through a successful terminal result. Closing immediately after Agent SDK `send()` could mark a message delivered even though the turn and message were dropped.
- Generated OpenCode plugin: if the `subconscious` CLI is not on PATH, the plugin prints one startup warning and stays idle. It does not print PATH contents, candidate paths, or secrets.

- **Deprecated `llm_config` PATCH shape** — `updateAgentModel()` was sending `{ llm_config: {...} }` as the agent PATCH body. Letta now rejects that with HTTP 400 ("The `llm_config` field is deprecated and no longer accepted. Use the `model` field instead."). The session-start model/context-window sync therefore failed silently on every Claude Code launch, leaving `LETTA_MODEL` / `LETTA_CONTEXT_WINDOW` env overrides un-applied — agents stayed pinned to whatever they last had server-side. Switched to the new top-level `model` + `context_window_limit` shape.

## [1.1.0] - 2026-01-28

### Added

- **PreToolUse hook for mid-workflow context injection** - New lightweight hook that checks for Letta agent updates before each tool use. Addresses "workflow drift" in long workflows by injecting new messages and memory block diffs mid-stream. Silent no-op if nothing changed.

- **Letta Code GitHub Action** - `@letta-code` can now respond to issues and PRs in this repository.

- **LETTA_BASE_URL support** - Self-hosted Letta servers can now be configured via environment variable.

- **Windows compatibility** - Fixed `npx spawn ENOENT` error on Windows.

- **Linux tmpfs workaround** - Documented workaround for `EXDEV` error when `/tmp` is on a different filesystem.

### Changed

- **Session start sync** - CLAUDE.md now syncs at session start for fresh agent/conversation IDs.

- **Default model** - Changed default agent model to GLM 4.7 (free tier on Letta Cloud).

- **Automatic model detection** - Plugin now queries available models and auto-selects if configured model is unavailable.

### Fixed

- **Plugin install syntax** - Updated README with correct marketplace install commands.

- **Conversation message ordering** - Fixed message fetch to correctly show newest messages first.

- **Conversation URL** - Links now point to agent view with conversation query param.

### Security

- **Sanitized default agent** - Removed user-specific data from bundled `Subconscious.af` file.

---

## [1.0.0] - 2026-01-16

Initial release.

### Features

- Bidirectional sync between Claude Code and Letta agents
- Memory blocks sync to `.claude/CLAUDE.md`
- Session transcripts sent to Letta agent asynchronously
- Conversation isolation per Claude Code session
- Auto-import default Subconscious agent if no agent configured
- Memory block diffs shown on changes
- New messages from Letta agent injected into context

### Hooks

- `SessionStart` - Notify agent of new session
- `UserPromptSubmit` - Sync memory before each prompt
- `Stop` - Send transcript after each response
