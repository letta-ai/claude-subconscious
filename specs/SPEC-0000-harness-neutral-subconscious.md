---
id: SPEC-0000
title: Harness-neutral Subconscious
status: implemented
dependencies: []
supersedes: []
implementation_links: []
---

# Harness-neutral Subconscious

## Goal

Build one local observer service for Claude Code, Codex, Letta Code, and later coding harnesses.

Each harness adapter sends observations to the service. A persistent Letta agent reviews those observations and stays silent unless it has useful guidance.

## Product decisions

- The product uses `@letta-ai/letta-agent-sdk` for agent, conversation, model, and turn operations.
- The product does not use `@letta-ai/letta-code-sdk` or direct Letta REST requests.
- The default model is `letta/auto`.
- Project configuration controls the observer agent, delivery permissions, and optional instructions.
- The observer sends user-visible output only through an explicit delivery tool.
- The service discards ordinary assistant output from the observer.
- Redaction is an extension point. A general redaction engine is not required for the first implementation.

## Process model

One local broker owns configuration, state, Agent SDK sessions, and pending deliveries.

Harness adapters send normalized events to the broker. The broker returns pending whispers through a fast local interface.

The broker serializes turns by Letta agent ID. This rule protects one MemFS repository when several project conversations use the same agent.

With `harnessBackend: "api"`, each local App Server session uses the agent's normal MemFS directory. Sessions for one agent therefore share one repository.

The broker stores state outside the project checkout. The state key includes the resolved configuration path and project root.

Adapters connect through a Unix domain socket on macOS and Linux. Windows adapters use a named pipe. The broker does not open a TCP port.

## Package boundaries

The rewrite uses the following packages:

```text
packages/
  core/                 configuration, routing, state, queue, and broker
  agent-runtime/        Agent SDK client, sessions, stream handling, and tools
  adapter-claude-code/  Claude Code hooks and plugin package
  adapter-codex/        Codex hooks and app-server integration
  adapter-letta-code/   Letta Code hooks and mod integration
  cli/                  init, start, stop, status, and adapter diagnostics
```

The current Claude-specific scripts are migration references. New packages do not import them.

The npm package name is `@letta-ai/subconscious`. The package includes the CLI, broker, shared core, and harness installation artifacts.

## Project discovery

Each adapter supplies its harness working directory and native session ID.

The core walks from that working directory toward the filesystem root. The nearest `subconscious.toml` file selects the project root and configuration.

A project without a configuration stays unobserved.

The nearest configuration wins. The core does not merge several project configurations.

## Project configuration

The first configuration version has the following shape:

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

The CLI can create a dedicated observer agent when `agent_id` is absent. Agent creation uses `model: "letta/auto"`, MemFS, and `baseTools: []`. It does not supply legacy memory block inputs or attach server-side tools.

The CLI does not attach optional external tools to a new observer agent.

The observer is a context manager. It routes durable project information into MemFS, retrieves context for the active task, and prepares a compact context packet for the next coding-agent turn.

MemFS uses progressive disclosure. Compact facts needed in most turns belong under `system/`. Detailed decisions, explanations, incidents, and history belong under `reference/`. Each file has frontmatter that describes its contents and retrieval trigger. The observer updates or deletes stale information instead of preserving contradictions.

An explicit model changes only conversations that Subconscious owns. Subconscious does not change unrelated conversations or the agent default.

Two configurations that name the same agent share that agent's memory. Separate agent IDs provide project memory isolation.

## Normalized harness events

Each adapter converts native events into this shared shape:

```ts
interface HarnessEvent {
  id: string;
  harness: "claude-code" | "codex" | "letta-code" | string;
  type:
    | "session_start"
    | "user_prompt"
    | "tool_result"
    | "turn_stop"
    | "session_end";
  sessionId: string;
  workingDirectory: string;
  occurredAt: string;
  sequence?: number;
  payload: unknown;
}
```

The adapter creates a stable event ID from native identity data when the harness supplies it. Claude Code and Codex use transcript markers. Letta Code uses a native turn or event ID when available. Current Letta Code Stop hooks have no turn ID, so that adapter uses a unique occurrence ID rather than silently dropping two identical turns. This fallback cannot deduplicate an external retry of the same hook process.

Adapters send bounded turn data. They do not repeatedly send the full transcript after every turn.

## Agent SDK boundary

The management client uses an explicit Cloud credential. The runtime client uses Cloud agents and local project tools:

```ts
const management = new LettaAgentClient({
  backend: "cloud",
  apiKey,
});

const runtime = new LettaAgentClient({
  backend: "local",
  appServer: {
    harnessBackend: "api",
    pinGlobalAgent: false,
  },
});
```

The local App Server runs the built-in read tools in the configured project root. Agent and conversation state remain in Letta Cloud.

Each runtime session receives the selected Cloud credential through its `env`. The runtime does not choose a different server from an ambient `LETTA_BASE_URL`.

Each session uses the following rules:

- Set `cwd` to the resolved project root.
- Set the model to the project model. The default is `letta/auto`.
- Disable skill loading with `skillSources: []`.
- Disable automatic dreaming with `dreaming: { trigger: "off" }`.
- Set `toolset: { base: "none", include: bundledTools }`. The bundled list contains only read tools and `memory_apply_patch`. Letta Code scopes `memory_apply_patch` to the observer's MemFS repository.
- Pass the complete `allowedTools` list separately. It contains the bundled tools and enabled custom delivery tools. Custom Agent SDK tools must not appear in `toolset.include`; Letta Code rejects them as unknown bundled tools.
- Use `permissionMode: "standard"` with a callback that allows the list and denies every other client tool.
- Drain one `session.stream()` for each sent observation.
- Require a successful terminal `result` before the event cursor advances.
- Close the session after the turn.

The first observation for a harness session uses `createSession(agentId, options)`. The broker stores the returned conversation ID.

Later observations for that harness session use `resumeSession(conversationId, options)`. Closing the session object does not delete the Letta conversation.

The broker sends the harness event ID as the Agent SDK `otid`. It does not retry automatically when transport status is unknown after `send()`.

The exact allowlist controls client-side tools. Tools attached to a supplied Letta agent remain subject to their server-side rules. The CLI reports that tool inventory separately.

The product uses Agent SDK management clients for agents, conversations, messages, models, and repositories. Missing SDK behavior becomes an Agent SDK issue and dependency.

## Explicit delivery tools

The observer receives two custom Agent SDK tools. Both tools execute in the broker process.

### `send_whisper`

`send_whisper` stores passive context for the next safe harness boundary.

```ts
interface SendWhisperInput {
  text: string;
  priority?: "normal" | "high";
  dedupeKey?: string;
  ttlSeconds?: number;
}
```

The tool closes over the harness route that caused the observer turn. The model cannot select another session as its target.

The tool stores the pending delivery before it returns success. The adapter acknowledges the delivery after it injects the context.

A whisper enters model context at the start of the next supported harness turn. It does not interrupt an active turn.

### `queue_message`

`queue_message` asks an adapter to add an actionable message to the harness queue.

```ts
interface QueueMessageInput {
  text: string;
  dedupeKey?: string;
}
```

The tool is available only when project configuration permits queued messages and the adapter supports them.

An unsupported queue request returns a tool error. The broker does not convert it into a whisper.

The tool targets only the harness route that caused the observer turn. An adapter must bind delivery to that native session and, when required, its expected active turn.

If the native session or turn no longer matches, the adapter reports a stale delivery. It does not inject the message into a replacement session.

### Delivery rule

No delivery tool call means no user-visible output. The broker never relays the observer's final assistant text.

Each delivery has a stable ID. Delivery is at least once. A crash after harness injection but before acknowledgement can repeat the same delivery ID.

The observer prompt permits a delivery when stored or newly learned context can help the next turn. Useful context includes:

- The user or harness addresses the observer directly.
- Project decisions and constraints related to the active task.
- Relevant file paths, commands, prior attempts, and known failures.
- Unresolved risks, corrections, and unfinished work.

The observer maximizes useful context rather than text volume. Progress summaries, praise, restatements, weak hunches, and unrelated facts do not qualify.

Observation processing remains nonblocking. Context prepared from one observation is available at the next safe prompt boundary.

## Session status

Install and start-up banners go to the terminal, so the harness never learns which Subconscious is attached to it. The assistant therefore cannot answer a question as basic as "which agent is watching this session?" without reading configuration files.

The broker exposes the session identity once per route: agent ID, model, harness, project root, conversation, and the delivery channels the project enables. The hook claims it at the same prompt boundary as whispers and the adapter renders it as `<subconscious_status>`.

The claim is atomic. Two hooks racing on one session produce one banner, and a route that has already surrendered its status returns nothing.

The route is created by the session's first observation, so the status lands on the first user prompt rather than at session start.

## Adapter contract

Each adapter declares its proven capabilities:

```ts
interface HarnessAdapterCapabilities {
  passiveContext: boolean;
  queuedMessage: boolean;
  transcript: "events" | "file" | "api" | "none";
}

interface AdapterDeliveryResult {
  status: "delivered" | "retry" | "stale" | "unsupported";
  nativeReceipt?: string;
}

interface HarnessAdapter {
  id: string;
  capabilities: HarnessAdapterCapabilities;
  normalize(input: unknown): Promise<HarnessEvent[]>;
  deliverWhisper(delivery: PendingWhisper): Promise<AdapterDeliveryResult>;
  queueMessage?(delivery: PendingMessage): Promise<AdapterDeliveryResult>;
}
```

An adapter does not claim a capability until a live test proves the current harness version.

## Initial adapters

### Claude Code

Claude Code hooks provide the working directory, session ID, transcript path, and lifecycle events.

The adapter uses `SessionStart`, `UserPromptSubmit`, and `Stop`. It does not poll Letta before every tool call.

Passive context uses the first live-proven hook output supported by the installed Claude Code version. `UserPromptSubmit` is the preferred boundary, so a whisper appears at the start of the next user turn.

Claude Code has no proven external queue API. `queue_message` stays unavailable until a live test proves one.

### Codex

Codex hooks and app-server events provide the working directory, thread ID, and lifecycle events.

The adapter must test passive hook context against Codex CLI 0.147.0 or later.

The adapter must test `thread/inject_items`, `turn/steer`, and `turn/start` against an active app-server thread. It exposes only the operations that pass.

### Letta Code

Letta Code hooks provide the working directory and structured turn fields. Session and prompt hooks include conversation identity. Current Stop input does not, and the hook executor strips conversation environment variables. The initial adapter therefore observes `SessionStart` and `UserPromptSubmit`. It skips a Stop event with no conversation ID rather than routing it through an agent-wide fallback. Completed-turn observation depends on a Letta Code hook contract that supplies the conversation ID.

The hook executor supports passive `additionalContext`. The adapter must still pass a real turn test.

The adapter must inspect the live message queue and mod APIs before it exposes `queue_message`.

## Durable state

The broker stores the following state:

- Project configuration identity and project root.
- Native harness session to Letta conversation routes.
- Last processed event ID or cursor for each harness session.
- In-flight event ID, Agent SDK `otid`, and reconciliation status.
- Pending whisper and queued-message deliveries.
- Delivery attempts, native receipts, acknowledgements, and deduplication keys.
- Agent ID, model, and Agent SDK connection identity.

State writes are atomic. One broker process owns writes. A stale process lock recovers without deleting pending deliveries.

The observation cursor advances only after the Agent SDK turn succeeds. A delivery remains pending until its adapter acknowledges it.

If a failure occurs after `send()` can have reached the runtime, the broker marks the event `needs_reconciliation`. Later observations on that route stay queued. `subconscious reconcile <event-id> --retry` checks recent Letta conversations for the `otid` before it retries. If the `otid` exists, the broker binds the route to that conversation and requires explicit discard after inspection. `--discard` releases the route without another observer turn.

One route maps one project configuration, Letta agent, harness type, and native harness session to one persistent Letta conversation.

## CLI surfaces

The CLI provides the following commands:

- `subconscious init [path]` creates a project configuration and optional observer agent.
- `subconscious start` starts the local broker.
- `subconscious stop` stops the broker after active turns finish.
- `subconscious status [path]` gives a concise project health summary for a human.
- `subconscious status [path] --detail` adds recent routes, observation history, and delivery history.
- `subconscious status [path] --json` reports complete route and tool metadata for scripts.
- `subconscious adapters` reports installed harness versions and live-tested capabilities.

`status` and `adapters` need no Letta credential. They do not change state.

## Acceptance criteria

### Shared core

- [x] The repository contains separate core, agent-runtime, CLI, and adapter packages.
- [x] The core discovers the nearest `subconscious.toml` from each harness working directory.
- [x] A project without configuration stays unobserved.
- [x] State uses atomic writes and one broker writer.
- [x] A route resumes one stored Letta conversation for every later event from the same native harness session.
- [x] Duplicate harness events do not create a second Agent SDK turn.
- [x] Turns that use one Letta agent run sequentially across all project conversations.
- [x] A failed Agent SDK turn does not advance the observation cursor.
- [x] An ambiguous send enters `needs_reconciliation` and does not retry automatically.
- [x] Reconciliation uses the event `otid` and the stored conversation route.
- [x] A pending delivery survives broker restart until an adapter acknowledges it.

### Agent SDK

- [x] Production code imports only `@letta-ai/letta-agent-sdk` for Letta operations.
- [x] Production code contains no direct `/v1/` Letta requests.
- [x] New observer agents use `letta/auto` and MemFS.
- [x] New observer agents do not create or attach legacy memory blocks.
- [x] The observer prompt routes durable information into MemFS and retrieves relevant context for the active task.
- [x] The observer prepares context for the next safe prompt boundary without blocking the current turn.
- [x] A live turn proves that the observer can read a configured project file through the local App Server.
- [x] A live turn proves that custom delivery tools execute in the broker process.
- [x] The runtime drains and checks the terminal `result` for every observation.
- [x] The runtime uses `toolset: { base: "none" }`, includes only bundled observer tools, and passes the complete bundled-plus-custom `allowedTools` list separately.
- [x] The client tool allowlist excludes shell, project mutation, delegation, interactive, and worktree tools.
- [x] The permission callback denies every client tool outside the allowlist.
- [x] The CLI reports attached server-side agent tools separately from the client tool allowlist.

### Delivery

- [x] A turn without a delivery tool call produces no harness output.
- [x] The broker discards ordinary assistant text from the observer.
- [x] `send_whisper` persists, deduplicates, expires, and acknowledges passive context.
- [x] `queue_message` is absent when configuration or adapter capability disables it.
- [x] An unsupported queue request returns a tool error without a whisper fallback.
- [x] Automated tests cover duplicate tool calls and broker restarts before acknowledgement.
- [x] Tests cover a crash after harness injection but before acknowledgement by reusing the same delivery ID.
- [x] A stale native session or active-turn ID never redirects a delivery to a replacement session.
- [x] The session status reaches the harness once per route and reports the agent, model, and delivery channels.
- [x] A second status claim on the same route returns nothing.

### Adapters

- [x] The Claude Code adapter proves project discovery, incremental observation, and passive whisper delivery in the real CLI.
- [x] The Claude Code adapter does not poll Letta before each tool call.
- [x] The Codex adapter proves project discovery and incremental observation in the real CLI.
- [x] The Codex adapter exposes only live-tested passive and queue capabilities.
- [x] The Letta Code adapter proves passive delivery through a real turn before release.
- [x] Each adapter reports unsupported capabilities without fallback behavior.

### Product validation

- [x] `subconscious status` runs without a Letta credential and does not change state.
- [x] Default status output shows broker health, the current project and observer, active work, pending whispers, and actionable failures.
- [x] Historical route output requires detail mode. Complete route and tool metadata requires JSON mode.
- [x] The package install test runs adapters from an unrelated working directory.
- [x] Tests cover two projects with different configurations under one parent directory.
- [x] Tests cover two harness sessions that share one observer agent.
- [x] Tests prove that shared-agent turns serialize against one MemFS repository.
- [x] A live acceptance test uses `letta/auto` and verifies the exact conversation route.
- [x] The repository's full check command validates specs, types, formatting, tests, and package contents.

## Non-goals

- Preserve the current Claude-specific implementation or state format.
- Keep the deprecated Letta Code SDK as a fallback.
- Relay every observer response into a harness.
- Add a general redaction engine in the first implementation.
- Expose shell, project mutation, or subagent tools through the Subconscious client toolset.
- Support every coding harness in the first release.
- Merge several project configuration files.
- Inject queued messages through an undocumented harness mechanism.

## Dependencies

None.

## Implementation links

None. Implementation starts after this spec reaches `approved`.
