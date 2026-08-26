# Subconscious

Subconscious lets any Letta agent observe another agent's session through small harness adapters. The bundled adapters support Claude Code, Codex, Letta Code, Hermes, and OpenCode, but the protocol is not limited to coding agents.

A one-time session message tells the Letta agent that it is monitoring another agent through Subconscious, names its delivery tools, requires verified guidance or explicit uncertainty, and supplies project instructions. Later observations contain only the new transcript event. Subconscious does not replace or rewrite the Letta agent's system prompt.

## Delivery contract

Subconscious exposes two Agent SDK tools:

- `send_whisper` stores passive context for the next supported harness boundary.
- `queue_message` sends an actionable message that starts a new harness turn.

Subconscious discards ordinary assistant text. No delivery tool call means no harness output.

Every adapter supports passive whispers. Only Letta Code supports `queue_message`, because a Letta Code session is a Letta agent in a Letta conversation that the broker can write to directly. Claude Code, Codex, Hermes, and OpenCode are foreign harnesses whose hooks cannot start a turn, so they keep `queue_message` disabled. A project also has to set `queue_messages = true`, which is off by default.

For a queued Letta message, the broker keeps the Agent SDK session open and drains the turn stream. It acknowledges delivery only after a successful terminal result; a failed or incomplete turn stays pending for retry under the same delivery OTID.

## Architecture

One local broker owns Agent SDK sessions, routes, event cursors, and pending deliveries.

```text
Claude Code ─┐
Codex ───────┼─ adapter ─ local broker ─ Letta Agent SDK ─ observer agent
Letta Code ──┼───────────────────────── │
Hermes ──────┼───────────────────────── │
OpenCode ────┘                         └─ persistent state and delivery acknowledgements
```

The broker uses a Unix domain socket on macOS and Linux. It uses a named pipe on Windows. It does not open a TCP port.

Each native harness session maps to one Letta conversation. The broker serializes all turns that use the same Letta agent. This rule protects the agent's shared MemFS repository.

## How a session becomes a whisper

1. **The harness calls its adapter.** The event includes the working directory, native session ID, and event type.
2. **The adapter finds the project configuration.** It searches parent directories for the nearest `subconscious.toml`. It exits when no configuration applies.
3. **The hook delivers pending whispers.** On `SessionStart` and `UserPromptSubmit`, the hook leases pending whispers before it records the current event. It formats each whisper for the harness and acknowledges delivery.
4. **The broker records the observation.** It rejects duplicate event IDs and maps the native session to one Letta conversation. It serializes observations that share an observer agent.
5. **The Subconscious agent uses its own judgment.** The session primer explains that it is monitoring the transcript and can guide the observed agent when important. Its existing identity, memory, shared repositories, and system prompt remain intact.
6. **Later observations stay small.** Each subsequent message contains only the new transcript event. When useful, the Subconscious agent calls `send_whisper`; ordinary assistant text is discarded.
7. **The next safe hook boundary delivers the whisper.** If no delivery tool is called, the harness receives no output.

For example, a coding agent can propose a change to an obsolete Python route. Subconscious can remember that TypeScript owns the route and call `send_whisper`. The coding agent receives that correction when the next user turn starts.

Subconscious does not block the active agent turn. Context from the current observation becomes available at the next safe prompt boundary.

The broker saves routes, observations, cursors, and pending deliveries under `~/.letta/subconscious/`. An ambiguous Agent SDK send blocks its route until reconciliation confirms whether the original event reached Letta.

## Requirements

- Node.js 22.19 or later
- A Letta Cloud API key in `LETTA_API_KEY`
- One supported coding harness

Subconscious uses `@letta-ai/letta-agent-sdk` 0.7.6. Project model settings are applied to the observer conversation rather than changing the supplied agent's default. It does not use the deprecated Letta Code SDK or direct Letta REST requests.

## Build from source

```bash
git clone https://github.com/letta-ai/claude-subconscious.git
cd claude-subconscious
npm install
npm run check
npm link
```

The npm package name is `@letta-ai/subconscious`.

## Configure a project

Run the following command from the project root:

```bash
export LETTA_API_KEY="your-api-key"
subconscious init
```

`subconscious init` creates a minimal observer agent with `letta/auto` and MemFS. It does not replace the standard Letta system prompt or create legacy memory blocks. You can instead attach any existing Letta agent with `subconscious init --agent agent-...`. Without an explicit `--model`, the written file names no model, so a new observer inherits its own `letta/auto` default and a supplied agent keeps whatever it already uses. `subconscious init --model <handle>` writes that model and applies it as a conversation override. The command then writes `subconscious.toml`, which for a plain init has no `model` line at all:

```toml
version = 1
agent_id = "agent-..."

[delivery]
whispers = true
queue_messages = false

[observer]
instructions = "Focus on regressions and forgotten project decisions."
```

Subconscious walks from the harness working directory toward the filesystem root. The nearest `subconscious.toml` file wins. A directory without this file stays unobserved.

### Choose a model

The `model` key is optional. When it is absent, the observer inherits whatever model the attached agent defaults to. An explicit `model` applies to every observer conversation for the project as a conversation-scoped override, so the supplied agent's own default stays untouched:

```toml
version = 1
agent_id = "agent-..."
model = "letta/auto"
```

One project can observe several harnesses, and each harness may want a different observer model. `[model_overrides.<harness>]` tables take precedence over the top-level `model` for that harness alone. Keys are `claude_code`, `codex`, `letta_code`, `hermes`, and `opencode`:

```toml
[model_overrides.claude_code]
model = "anthropic/claude-sonnet-5"
reasoning_effort = "high"
context_window_limit = 200000

[model_overrides.claude_code.settings]
temperature = 0.2
```

Each override table accepts:

- `model`: a non-empty model handle.
- `reasoning_effort`: one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`. The runtime re-applies it on every observer turn.
- `context_window_limit`: a positive whole number, persisted on the conversation.
- `settings`: a table of provider-specific model settings, persisted on the conversation. Values must be JSON-compatible and cannot be null.

`reasoning_effort` and `settings` are mutually exclusive in one table: the first asks the normalized runtime for a reasoning tier, while the second replaces provider settings directly, and combining them would make their precedence ambiguous. Fields a harness table omits fall back to the lower levels: an effort-only override keeps the project-wide model.

Precedence is therefore: harness override, then the project-wide `model`, then the attached agent's default. Editing an override takes effect on that harness's next observation, which updates the existing Subconscious conversation in place; removing one clears the persisted overrides so the conversation inherits again. No route or conversation is ever forked by a model change.

Add `sandbox = true` under `[observer]` to run the observer's tools in a Letta managed sandbox instead of on this machine. The sandbox does not mount the project, so the observer keeps its MemFS and can no longer read project files. Leave the key out for local tools and full project access.

By default the observer sees a session start, a prompt, and a completed turn. Add `mid_turn = true` under `[observer]` to also observe tool boundaries inside a turn, so a whisper can reach the coding agent while it is still working instead of waiting for the next prompt. Two settings control what that costs:

```toml
[observer]
mid_turn = true
mid_turn_min_tool_calls = 5
mid_turn_min_seconds = 90
```

`mid_turn_min_tool_calls` is how many tool calls one observation must cover before it runs. `mid_turn_min_seconds` is the quiet period after the observer's previous turn on that session. Both must pass. Raise either one to spend fewer observer turns on a busy session.

`npm run check` runs the fast suite. `npm run test:e2e` is separate: it starts a real Claude Code process with the hook registered, and checks that a whisper waiting in the broker is read back by the model. It needs the `claude` binary and a logged-in session, and takes about ten seconds per case.

`npm run test:model-e2e` is a second opt-in suite for the model-override pipeline: it creates one disposable hidden observer, drives two real turns with a full harness override and then with every override removed, and checks the server-persisted conversation state each time. It needs `LETTA_API_KEY` in the environment and no Claude authentication; without the key it fails loudly rather than skipping.

Two configurations can use one observer agent. Those projects share the agent's memory. Use separate agent IDs for project memory isolation.

## Install an adapter

### Claude Code

Install the bundled plugin:

```text
/plugin marketplace add letta-ai/claude-subconscious
/plugin install claude-subconscious@claude-subconscious
```

The plugin runs `SessionStart`, `UserPromptSubmit`, and `Stop` hooks. It does not poll before each tool call.

### Codex

```bash
subconscious install codex
```

This command adds Subconscious hooks to `~/.codex/hooks.json`. It preserves existing hooks.

### Letta Code

Run this command from the project root:

```bash
subconscious install letta-code
```

This command adds hooks to `.letta/settings.local.json`. It preserves existing project settings.

### Hermes

```bash
subconscious install hermes
```

This command adds four shell hooks to the active Hermes profile's `config.yaml` (`on_session_start`, `pre_llm_call`, `post_tool_call`, `on_session_end`) and seeds exactly those four entries in Hermes' hook-consent allowlist. It never flips `hooks_auto_accept`. User comments and unrelated hooks are preserved, and rerunning changes nothing.

Hermes reads whisper context only at its turn prologue (`pre_llm_call`), so guidance waits for the coding agent's next prompt rather than arriving mid-turn — this is narrower than the Claude Code and Codex adapters, which can also deliver at tool boundaries. Observations read the active profile's `state.db` transcript directly; no per-session JSONL is involved.

### OpenCode

Run this command from the project root, or pass a target project path:

```bash
subconscious install opencode [path]
```

This command writes `.opencode/plugins/subconscious.js` in that project only. It preserves unrelated project files, refuses to overwrite a conflicting target it does not own, and rerunning it changes nothing when the generated file is already current.

The shipped adapter is tested against OpenCode 1.18.23 and plugin SDK 1.2.27. The generated plugin observes `session.created`, `chat.message`, terminal `message.part.updated` tool parts only when `observer.mid_turn` is enabled, `session.status` when it turns idle, and `session.deleted` plus server disposal for deterministic session-end signals. `tool.execute.after` is observation-free because OpenCode 1.18.23 fires it before terminal tool state commits. Child sessions keep separate route identities.

OpenCode transcript deltas come from the official `client.session.messages` API. The plugin forwards a bounded recent snapshot, and the adapter normalizes it into stable `key#version` records so mutable same-ID content replays the visible tail instead of being skipped. This is what keeps streaming rewrites and bounded-tail truncation from silently dropping context.

Passive delivery uses two host-specific channels. At the prompt boundary, after `chat.message` has captured the original prompt for observation, the plugin leases the delivery window and appends one synthetic text part containing the combined status-plus-whisper block to `output.parts`; acknowledgement follows only after that append succeeds. This is the reliable resumed-session channel, and transcript normalization ignores that synthetic part. `experimental.chat.system.transform` remains the mid-turn model-step channel for whispers produced after the prompt while a turn is already running; it appends whispers there and acknowledges after that mutation succeeds. OpenCode does not support `queue_message`, and pending-delivery cleanup after session end remains TTL-based rather than forced by the harness.

With `observer.mid_turn = true`, each observed tool boundary costs one local snapshot fetch and one local broker enqueue attempt, not an observer turn by itself. The broker still coalesces busy runs behind `mid_turn_min_tool_calls` and `mid_turn_min_seconds`, so the cost is bounded by those thresholds rather than by raw tool count.

## Operate the broker

Hooks start the broker when necessary. You can also control it directly:

```bash
subconscious start
subconscious status
subconscious adapters
subconscious stop
```

`subconscious status` needs no Letta credential. Its default output shows the broker, current project, observer, active work, pending whispers, and failures:

```text
Subconscious status

Broker      online (PID 20267)
Project     ~/letta/claude-subconscious
Observer    agent-184c033f-cca... (letta/auto)
Work        1 processing, 1 queued
Whispers    none waiting
Failures    none
```

Use detail mode to inspect recent routes and history:

```bash
subconscious status --detail
```

Use JSON for scripts and complete route metadata:

```bash
subconscious status --json
```

An interrupted Agent SDK send blocks later events on the same route. The default status output prints a safe retry command. Detail mode lists all recent failure IDs.

```bash
subconscious reconcile <event-id> --retry
subconscious reconcile <event-id> --discard
```

`--retry` first searches the observer's conversation history for the same Agent SDK `otid`. It does not retry when that `otid` already exists. Use `--discard` only after you decide that the interrupted event can be skipped.

State lives in `~/.letta/subconscious/`. Set `SUBCONSCIOUS_HOME` to use a different directory.

## Reliability rules

- The broker writes state atomically.
- Native transcript markers prevent duplicate observer turns in Claude Code and Codex.
- Letta Code uses a native turn ID when available. Current Letta Code hooks have no turn ID, so the adapter uses a unique occurrence ID rather than dropping identical turns.
- OpenCode uses a bounded snapshot tail and a `key#version` cursor marker, so mutable same-ID transcript rewrites replay the visible tail instead of being skipped.
- A stable delivery ID prevents normal duplicate delivery records.
- A delivery remains pending until its adapter acknowledges it.
- A crash after injection but before acknowledgement can repeat the same delivery ID.
- An unknown send result enters `needs_reconciliation`. The broker does not retry it blindly.
- A route with an unresolved send does not start later observer turns.
- A whisper stays bound to its originating harness session.

## Development

Run the full local check:

```bash
npm run check
```

The check validates the specification index, formatting, TypeScript, unit tests, package build, and package contents.

The approved design is in [`specs/SPEC-0000-harness-neutral-subconscious.md`](specs/SPEC-0000-harness-neutral-subconscious.md).

## Current limits

- The first implementation targets Letta Cloud.
- Harness queue delivery remains disabled until each native queue passes a live acceptance test.
- OpenCode's adapter, installer, snapshot replay, generated-plugin bridge, and real CLI/model delivery path are covered by focused tests. The live suite proves a resumed OpenCode session receives a seeded whisper on the prompt boundary, that the observer sees the terminal bash result through the post-commit tool path, and that the whisper reaches only the intended session.
- Current Letta Code Stop hooks omit the conversation ID and strip conversation environment variables. The adapter observes `SessionStart` and `UserPromptSubmit` safely. Completed-turn observation needs a Letta Code hook contract update.
- The redaction interface is planned, but the first implementation has no general redaction engine.
- An existing observer agent can have server-side tools. The Subconscious client allowlist does not control those tools.
