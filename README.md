# Subconscious

Subconscious is a persistent context manager for coding-agent sessions. It supports Claude Code, Codex, and Letta Code through small harness adapters.

A Letta agent routes durable project information into MemFS. It retrieves relevant context and prepares it for the next coding-agent turn.

## Delivery contract

Subconscious exposes two Agent SDK tools:

- `send_whisper` stores passive context for the next harness turn.
- `queue_message` sends an actionable message that starts a new harness turn.

Subconscious discards ordinary assistant text. No delivery tool call means no harness output.

Every adapter supports passive whispers. Only Letta Code supports `queue_message`, because a Letta Code session is a Letta agent in a Letta conversation that the broker can write to directly. Claude Code and Codex are foreign harnesses whose hooks cannot start a turn, so they keep `queue_message` disabled. A project also has to set `queue_messages = true`, which is off by default.

## Architecture

One local broker owns Agent SDK sessions, routes, event cursors, and pending deliveries.

```text
Claude Code ─┐
Codex ───────┼─ adapter ─ local broker ─ Letta Agent SDK ─ observer agent
Letta Code ──┘                  │
                               └─ durable state and delivery acknowledgements
```

The broker uses a Unix domain socket on macOS and Linux. It uses a named pipe on Windows. It does not open a TCP port.

Each native harness session maps to one Letta conversation. The broker serializes all turns that use the same Letta agent. This rule protects the agent's shared MemFS repository.

## How a session becomes a whisper

1. **The harness calls its adapter.** The event includes the working directory, native session ID, and event type.
2. **The adapter finds the project configuration.** It searches parent directories for the nearest `subconscious.toml`. It exits when no configuration applies.
3. **The hook delivers pending whispers.** On `SessionStart` and `UserPromptSubmit`, the hook leases pending whispers before it records the current event. It formats each whisper for the harness and acknowledges delivery.
4. **The broker records the observation.** It rejects duplicate event IDs and maps the native session to one Letta conversation. It serializes observations that share an observer agent.
5. **The observer manages context.** It retrieves related MemFS files, reads project files when necessary, and routes new durable information into MemFS.
6. **The observer prepares the next turn.** It calls `send_whisper` with relevant decisions, constraints, paths, previous attempts, risks, or pending work. Ordinary assistant text is discarded.
7. **The next safe hook boundary delivers the whisper.** If the observer does not call a delivery tool, the harness receives no output.

For example, a coding agent can propose a change to an obsolete Python route. Subconscious can remember that TypeScript owns the route and call `send_whisper`. The coding agent receives that correction when the next user turn starts.

The observer does not block the active coding-agent turn. Context from the current observation becomes available at the next safe prompt boundary.

The broker saves routes, observations, cursors, and pending deliveries under `~/.letta/subconscious/`. An ambiguous Agent SDK send blocks its route until reconciliation confirms whether the original event reached Letta.

## Requirements

- Node.js 22.19 or later
- A Letta Cloud API key in `LETTA_API_KEY`
- One supported coding harness

Subconscious uses `@letta-ai/letta-agent-sdk` 0.7.1. It does not use the deprecated Letta Code SDK or direct Letta REST requests.

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

`subconscious init` creates an observer agent with `letta/auto` and MemFS. It does not create or attach legacy memory blocks. It then writes `subconscious.toml`:

```toml
version = 1
agent_id = "agent-..."
model = "letta/auto"

[delivery]
whispers = true
queue_messages = false

[observer]
instructions = "Focus on regressions and forgotten project decisions."
```

Subconscious walks from the harness working directory toward the filesystem root. The nearest `subconscious.toml` file wins. A directory without this file stays unobserved.

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
- Current Letta Code Stop hooks omit the conversation ID and strip conversation environment variables. The adapter observes `SessionStart` and `UserPromptSubmit` safely. Completed-turn observation needs a Letta Code hook contract update.
- The redaction interface is planned, but the first implementation has no general redaction engine.
- An existing observer agent can have server-side tools. The Subconscious client allowlist does not control those tools.
