# Harness integration priorities

Status: research-backed planning snapshot, 2026-08-25

This document prioritizes the next Subconscious harness adapters after Claude
Code, Codex, Letta Code, Hermes, and OpenCode. It combines the token-activity ranking supplied by
Cameron with integration feasibility and implementation leverage.

The token numbers are a reach signal, not market share. One automated workload
can generate more tokens than many interactive users, and the list mixes coding
harnesses, personal agents, APIs, games, and SaaS products. A high token count
therefore earns investigation, not automatic priority.

## Decision criteria

In order of importance:

1. **Observed reach** — token activity in the supplied ranking.
2. **Correct lifecycle access** — stable session identity, user prompts, tool
   outcomes, failures, turn completion, working directory, and transcript data.
3. **Delivery** — a supported way to inject passive context, steer a running
   turn, or start a queued turn without scraping a terminal.
4. **Implementation leverage** — one protocol or shared core that unlocks
   multiple harnesses.
5. **Installation quality** — project-local and user-level installation that is
   quiet, idempotent, reversible, and preserves unrelated configuration.
6. **Maintenance risk** — preference for typed, documented, versioned extension
   APIs over private internals or screen scraping.

## Current coverage

| Harness      | Ranking signal | State                                                                                          |
| ------------ | -------------: | ---------------------------------------------------------------------------------------------- |
| Claude Code  |           940B | Supported (live seeded whisper read-back at prompt and PostToolUse)                            |
| Codex        |           191B | Adapter shipped (schema-backed delivery; real CLI proof pending)                               |
| Letta Code   |      Not shown | Adapter shipped (queue path unit-tested; live passive delivery pending)                        |
| Hermes Agent |          2.67T | Supported (adapter shipped; live whisper read-back pending)                                    |
| OpenCode     |      Not shown | Supported (live resumed prompt delivery and terminal observation; mid-turn transform unit-tested) |

These adapters remain the compatibility baseline. A new adapter should not be
called complete merely because it can run a command on `Stop`; it must meet the
acceptance contract below.

## Recommended implementation order

### 1. Hermes Agent

**Signal:** 2.67T, first in the supplied ranking.

Hermes is the highest-reach unsupported harness by a large margin. A source
review against Hermes 0.20.5 verified the exact path. Config-driven shell hooks
receive `session_id`, `cwd`, turn/tool/request identifiers, model, and platform.
The useful mapping is:

- `on_session_start` -> session start;
- `pre_llm_call` -> user prompt and passive whisper delivery;
- `post_tool_call` -> tool success or failure, distinguished by `status`;
- `on_session_end` -> per-turn stop, despite the event's name.

Only `pre_llm_call` consumes hook output, accepting `{"context":"..."}` for
the upcoming model request. `post_tool_call` is observer-only, so Hermes cannot
accept a mid-turn whisper after each tool. The canonical transcript is the
SQLite store at `<active-hermes-home>/state.db`, table `messages`, whose
autoincrement `id` is a natural cursor; no live writer of
`sessions/<session_id>.jsonl` was found in Hermes 0.20.5, and the earlier plan
to reuse the Codex JSONL delta reader was wrong. The shipped adapter reads
state.db read-only through Node's built-in `node:sqlite`, lazily imported so
non-Hermes hooks never pay an experimental-module warning.

**Decision:** first standalone adapter, implemented through the stable shell
hook protocol. Install four hooks in the active Hermes profile's YAML, preserve
comments, and seed only the adapter's hook-consent allowlist entries rather than
enabling all hooks globally. Advertise passive context but not queued messages.
Profile resolution mirrors upstream `_apply_profile_override`: a HERMES_HOME
whose parent is `profiles` is final, otherwise `<root>/active_profile` decides.
The hook subprocess stamps its resolved HERMES_HOME into every payload, so a
broker spawned by any other harness still reads the right profile's store.

**Implemented limitations:** whispers are next-turn-only — `pre_llm_call`
fires once per turn prologue, so guidance waits for the user's or agent's next
prompt rather than arriving at a tool boundary inside a turn. A backlog larger
than one 400-row page is reported as truncated in the observation and finished
at the next boundary rather than silently skipped.

**Status:** adapter, installer, allowlist seeding, profile resolution, and
synthetic state.db tests are complete and green. Still outstanding before this
row reads plain "Supported": one live smoke test proving payload fidelity,
allowlist registration, and JSON context read-back against a real `hermes chat`
process.

### 2. DeepSeek Harness

**Signal:** 602B.

DeepSeek Harness is unusually attractive because it offers two routes:

- a native Cordis plugin can consume the canonical `session/event` replay
  stream and live `agent/*` interception points such as `agent/pre-step`,
  `agent/request`, and `agent/turn-stopping`;
- its shipped Claude Code hook bridge already maps `SessionStart`,
  `UserPromptSubmit`, `PostToolUse`, and `Stop`-style command hooks onto those
  points.

The compatibility bridge is the fastest pilot. A native plugin is the proper
long-term integration because it has typed context and no shell serialization
boundary. Native `Agent.inject()`, `steer()`, and `followup()` methods also make
whisper delivery explicit. The current bridge loads one process-level hook
config and does not yet discover a separate project hook config per session, so
the pilot must not pretend project isolation is solved.

**Decision:** implement immediately after Hermes. Prototype through the shipped
Claude-hook bridge, then replace or wrap it with a native Cordis plugin.

### 3. Pi family: omp and pi

**Combined signal:** 695B (`omp` 396B + `pi` 299B).

These should be designed together, not as unrelated adapters. omp is a Pi fork,
and both expose TypeScript extension APIs with session, turn, tool, and message
events.

- omp documents `session_start`, `turn_start`, `turn_end`, `tool_call`,
  `tool_result`, and `session_stop`; pi exposes the same core shape plus an
  `agent_settled` boundary.
- Both expose `sendMessage()` with `deliverAs: "steer" | "followUp" |
"nextTurn"`, optional `triggerTurn`, and custom messages with `display:
false`. That directly represents passive hidden context, mid-run steering,
  and proactive queued turns.
- Both expose transcript trees and stable session identity through
  `ctx.sessionManager`.

The event vocabularies have diverged, so the reusable unit should be a small
Pi-family normalization core plus thin `omp` and `pi` bindings. Do not assume
binary compatibility merely because of shared ancestry.

**Decision:** build one family milestone after DeepSeek. omp goes first because
its hook, SDK, RPC, and steering surfaces are explicit; port the normalized core
to upstream pi immediately afterward.

### 4. Kilo plugin family

**Signal:** Kilo Code 461B.

Kilo's current plugin API exposes the same internal event-bus family OpenCode
uses, including `session.created`, `session.idle`, `session.error`,
`message.updated`, `tool.execute.before`, and `tool.execute.after`. Plugins work
in both the Kilo CLI and VS Code extension. The plugin receives stable
`sessionID` values and can participate directly in chat and tool processing.
Passive context can be added through `chat.message` or provider-bound message
and system transforms; intentional proactive delivery can use SDK
`session.promptAsync()`. Because plugin hooks are awaited sequentially, the
adapter must only enqueue local work before returning.

OpenCode compatibility is implemented against OpenCode 1.18.23 / plugin SDK 1.2.27. Live tests cover resumed-session prompt delivery and post-commit terminal tool observation. Mid-turn `experimental.chat.system.transform` delivery is covered by plugin tests, not the live CLI suite. The shipped design uses `chat.message` synthetic prompt context for resumed-session delivery, `experimental.chat.system.transform` for mid-turn delivery after the prompt, and terminal `message.part.updated` as the canonical tool observation seam. The next leverage play in this family is Kilo: reuse the same normalization ideas where the host types and behavior actually match, rather than inferring compatibility from branding.

**Decision:** implement Kilo next as the second tested host in this plugin family, reusing the OpenCode bridge and snapshot patterns where the contracts truly align.

### 5. Cline

**Signal:** 352B.

Cline provides both external file hooks and typed in-process plugins:

- file hooks cover task start/resume/cancel/complete, user prompts, tool
  pre/post, and compaction with serialized JSON;
- plugin hooks expose `beforeRun`, `afterRun`, `beforeModel`, `afterModel`,
  `beforeTool`, `afterTool`, and every runtime event.

The file-hook path is appropriate for a minimal adapter. A reusable Cline plugin
is the higher-fidelity target because it can inject context before model calls
and works across Cline's CLI, SDK, VS Code, JetBrains, and other SDK hosts.
Official plugin examples also demonstrate asynchronous host delivery through
`steer_message`, giving the adapter a supported outbound path after its hook has
already returned. Keep stable `sessionId`, transcript `conversationId`, and
per-run `runId` distinct.

**Decision:** ship a command-hook compatibility adapter first, then package the
same broker client as a native Cline plugin.

### 6. Cursor

**Signal:** 84.5B in the supplied snapshot, but a much broader installed-product
surface than that single activity number captures.

Cursor now has a first-class hook and plugin system. Official hooks include
`sessionStart`, `beforeSubmitPrompt`, generic tool pre/post/failure,
shell/MCP/file events, `preCompact`, `stop`, and `sessionEnd`. Hooks communicate
as JSON over stdio and can be packaged in a Cursor plugin. Project hooks also run
in Cursor Cloud Agents once the writable environment is available.

This is no longer a speculative or screen-scraping integration. The remaining
work is careful event deduplication: generic tool hooks may overlap dedicated
shell and MCP hooks, while `stop` and `sessionEnd` are distinct boundaries.
Verified injection points are `sessionStart.additional_context`,
`postToolUse.additional_context`, and `stop.followup_message`;
`beforeSubmitPrompt` should not be assumed to support arbitrary same-turn
context unless a live version proves it.

**Decision:** prioritize ahead of higher-token but poorly extensible products.
Start with project hooks, then package for the reviewed Cursor marketplace.

### 7. ZCode

**Signal:** 185B.

ZCode supports seven relevant command-hook events: `SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`,
`PostToolUseFailure`, and `Stop`. It supports plugin manifests and structured
`additionalContext` injection, but current behavior has sharp edges:

- hook output validation is strict;
- command hooks run inline and the advertised async field has no runtime effect;
- config-file command syntax and plugin syntax differ;
- subagent hook propagation has reported gaps;
- full conversation recovery may require the local rollout JSONL rather than
  the hook payload alone.

**Decision:** implement after Cursor as a translated Claude-style command-hook
adapter with explicit version probes and strict fixtures. Never block `Stop` on
network work.

### 8. OpenClaw

**Signal:** 165B.

OpenClaw is a personal-agent runtime rather than only a coding harness, which
makes it relevant to Subconscious's broader event-stream goal. Its plugin system
is excellent: typed hooks cover agent runs, model calls, tools, messages,
sessions, subagents, and Gateway lifecycle. The host SDK also exposes durable
exactly-once next-turn injection through
`session.workflow.enqueueNextTurnInjection()`. `agent_turn_prepare` and
`before_prompt_build` provide same-turn context seams, while raw conversation
access and prompt mutation are separately capability-gated.

**Decision:** pursue after the primary coding-harness wave. Implement as an
in-process workflow plugin, not an external command-hook approximation. It is a
strong candidate for full `queue_message` support.

### 9. Command Code

**Signal:** 52.4B.

Command Code has working `SessionStart`, `PreToolUse`, `PostToolUse`, and `Stop`
hooks in `~/.commandcode/settings.json`; the existing Herdr integration is a
useful source-backed reference for installation and lifecycle behavior.

**Decision:** a reasonable lower-cost adapter after ZCode/OpenClaw. First verify
payload access to prompts, transcript history, and stable session identity;
lifecycle-state hooks alone are insufficient for Subconscious observations.

### 10. OpenHands

**Signal:** 68.5B.

OpenHands exposes conversations, persisted events, callbacks, REST endpoints,
and a WebSocket event stream through its Agent Server and SDK. `HookConfig`
supports session, prompt, tool, stop, and completion boundaries, while
conversation plugins can be loaded from GitHub, Git, or local paths. This is a
good technical fit but a different integration shape: Subconscious would be an
SDK plugin and event consumer rather than only a local CLI hook.

**Decision:** implement after the local harnesses. Design it as a server adapter
with explicit reconnect, cursor, and event-deduplication semantics. It should be
capable of queued turns through `sendMessage()` and `run()`.

## High-reach item currently blocked

### Zazen / Freebuff fork

**Signal:** 516B.

The ranking label does not identify a stable public Zazen integration target.
The closest verified upstream is Freebuff/Codebuff. Freebuff has an SDK and open
agent runtime, but its CLI does not expose a general internal lifecycle-hook
system; the existing Herdr integration has to poll chat state files and inspect
terminal output.

**Decision:** do not prioritize a scraper solely because of the 516B number.
First identify the exact Zazen build and determine whether its fork added a
supported event API. Otherwise pursue a Codebuff SDK integration or request an
upstream hook surface.

## Items in the ranking that are not current harness targets

| Rank | Product           | Signal | Disposition                                                                  |
| ---: | ----------------- | -----: | ---------------------------------------------------------------------------- |
|   12 | Nous Research API |   140B | Research/model API, not an interactive harness target                        |
|   13 | Cheaper Inference |   106B | Inference service, not a harness                                             |
|   16 | Framer            |  66.1B | Product-building application; requires a separate product API investigation  |
|   17 | ISEKAI ZERO       |  63.3B | Game, not a harness                                                          |
|   18 | HighLevel         |  63.3B | SaaS platform, not presently an agent-harness target                         |
|   20 | Hello Minds       |  48.6B | Personal/creative agent product; no verified developer lifecycle surface yet |

Exclusion is not a judgment about product importance. It means the screenshot
does not establish a compatible session lifecycle that Subconscious can observe.

## Acceptance contract for every new adapter

An adapter is complete only when all applicable items are source-verified and
tested:

1. Stable native session identity survives resume.
2. Working directory and project-config discovery are authoritative.
3. `session_start`, `user_prompt`, tool success, tool failure, and turn stop map
   to native events without duplicate observations.
4. Transcript deltas cannot silently omit assistant or tool content.
5. Hooks are quiet and do not put routine status lines in the user's UI.
6. Observation work does not block the harness's tool or stop boundary.
7. Passive whispers arrive at a documented safe context boundary.
8. `queue_message` is advertised only when the harness can start a turn with a
   confirmed delivery result.
9. Installation preserves unrelated configuration, is idempotent, and can be
   cleanly removed.
10. Fixtures cover malformed payloads, duplicate events, restarts, timeouts,
    config migration, and Windows path/command quoting.
11. At least one real end-to-end test proves observation and whisper delivery in
    the actual harness.

## Suggested delivery waves

| Wave    | Targets                           | Goal                                                             |
| ------- | --------------------------------- | ---------------------------------------------------------------- |
| 0       | Claude Code, Codex, Letta Code    | Keep current baseline green                                      |
| 1       | Hermes, DeepSeek Harness          | Cover the two highest-priority standalone targets                |
| 2       | omp + pi, Kilo                    | Build reusable family-level normalization cores                  |
| 3       | Cline, Cursor, ZCode              | Cover plugin/hook-driven desktop and CLI coding agents           |
| 4       | OpenClaw, Command Code, OpenHands | Expand beyond local coding-hook integrations                     |
| Blocked | Zazen/Freebuff                    | Resolve product identity or obtain a supported lifecycle surface |

## Sources

- Activity ranking: screenshot supplied by Cameron on 2026-08-25.
- Hermes hooks and plugins:
  <https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks>,
  <https://hermes-agent.nousresearch.com/docs/developer-guide/plugins>
- DeepSeek Harness repository and hook bridge:
  <https://github.com/deepseek-ai/deepseek-harness>
- DeepSeek Claude Code hook bridge:
  <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/hooks/hooks-claude-code/README.md>
- omp hooks, SDK, and RPC:
  <https://omp.sh/docs/hooks>, <https://omp.sh/docs/sdk>,
  <https://omp.sh/docs/rpc>
- pi extensions:
  <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md>
- Kilo plugins:
  <https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-docs/pages/automate/extending/plugins.md>
- Cline plugin reference and examples:
  <https://github.com/cline/cline/blob/main/.agents/skills/cline-sdk/references/plugins/REFERENCE.md>,
  <https://github.com/cline/cline/tree/main/sdk/examples/plugins>
- Cursor hooks and plugins: <https://cursor.com/docs/hooks>,
  <https://cursor.com/docs/reference/plugins>
- ZCode integration research:
  <https://github.com/volcengine/OpenViking/blob/main/examples/zcode-memory-plugin/DESIGN.md>
- OpenClaw plugin hooks:
  <https://github.com/openclaw/openclaw/blob/main/docs/plugins/hooks.md>
- Command Code repository and Herdr integration reference:
  <https://github.com/CommandCodeAI/command-code>,
  <https://github.com/TheMetalStorm/herdr-commandcode-plugin>
- OpenHands Software Agent SDK and TypeScript client:
  <https://github.com/OpenHands/software-agent-sdk>,
  <https://github.com/OpenHands/typescript-client>
- Freebuff repository and Herdr integration reference:
  <https://github.com/CodebuffAI/freebuff>,
  <https://github.com/TheMetalStorm/herdr-freebuff-plugin>
