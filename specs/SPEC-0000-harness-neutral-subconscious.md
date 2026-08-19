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

The broker outlives the code that started it. Its descriptor therefore records which build is serving, and an adapter that finds a live broker from another build stops it and starts its own. A liveness check alone would reuse a daemon that answers every request with older behavior, which reads as the new code silently doing nothing.

The fingerprint is the entry point's path and modification time. It catches a different install location, an upgrade, and a rebuild. It does not catch editing a source file the entry point does not import directly, so `subconscious restart` remains the explicit control.

## Package boundaries

The rewrite uses the following packages:

```text
packages/
  core/                 configuration, routing, state, queue, and broker
  agent-runtime/        Agent SDK client, sessions, stream handling, and tools
  adapter-claude-code/  Claude Code hooks and plugin package
  adapter-codex/        Codex hooks and app-server integration
  adapter-letta-code/   Letta Code hooks and mod integration
  cli/                  init, start, stop, restart, status, and adapter diagnostics
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
sandbox = false
```

`observer.sandbox` chooses where the observer's tools run. It is off by default, and an absent key means the tools run in the broker process against the project root, which is the only behavior earlier versions had.

When it is on, the runtime opens the session through a Cloud client that owns a Letta managed sandbox. Nothing the observer runs touches the user's machine. The cost is the project: a managed sandbox does not mount local paths, so the read tools reach the agent's MemFS projection and nothing else. The observer then works from MemFS and the observation text alone, and the observation prompt says so rather than letting it guess why a project path is missing.

The bundled toolset does not change. MemFS is a filesystem projection that travels with the agent, so `Read`, `LS`, `Glob`, and `Grep` are how the observer retrieves memory wherever it runs. Removing them would leave an observer that can write memory and never read it. The delivery tools execute in the broker process over the external-tool protocol, so they behave the same on both transports.

A sandboxed session sends no `cwd` and no session `env`. The project root does not exist in the sandbox, cloud transports ignore session env, and the Cloud client carries the credential instead.

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

A project that sets `observer.sandbox` replaces the runtime client with a Cloud client that owns a managed sandbox:

```ts
const sandboxRuntime = new LettaAgentClient({
  backend: "cloud",
  apiKey,
  sandbox: {
    ttlMinutes: 5,
    refreshIntervalMs: 240_000,
    terminateOnClose: false,
  },
});
```

The runtime builds that client on the first sandboxed observation, so a project that never asks for a sandbox never opens a Cloud session. The sandbox outlives one session because each observation opens and closes a session on the same resumed conversation, and terminating on close would pay a cold start every turn. The tool inventory read after the turn uses the same client as the turn.

Each session uses the following rules:

- Set `cwd` to the resolved project root. A sandboxed session sends no `cwd` and no `env`.
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

`queue_message` adds an actionable message that starts a new coding-agent turn.

```ts
interface QueueMessageInput {
  text: string;
  dedupeKey?: string;
}
```

The tool is available only when project configuration permits queued messages and the adapter supports them. `delivery.queue_messages` defaults to false, so a project opts in before the tool exists.

An unsupported queue request returns a tool error. The broker does not convert it into a whisper.

The tool targets only the harness route that caused the observer turn. The model cannot select another session as its target.

A queued message does not wait for a hook. A hook runs at a turn boundary the harness chose, which is exactly what an actionable message must not be bound to. The broker therefore delivers it itself, and only to a harness whose session it can address directly.

A harness that runs as a Letta agent exposes its own Letta agent and conversation IDs on each event. Those IDs belong to the coding agent, never to the observer, and the broker records them on the route separately from the observer's agent and conversation. The broker sends the message into that conversation with the Agent SDK. The message is in the coding agent's context from its next turn onward.

The delivery session carries no model and no client tools. A model would rewrite the coding agent's own configuration, and a client tool would make the broker process a device that executes the coding agent's tool calls.

The broker acknowledges a queued message itself, because no hook is present to acknowledge it. The delivery ID travels as the send OTID, so a retry after an unknown transport result deduplicates instead of posting the message twice.

If the conversation no longer belongs to the observed agent, the delivery is stale. It is never redirected into a replacement session. A transport failure leaves it pending with the reason recorded, and the next observer turn or broker start retries it.

### Delivery rule

No delivery tool call means no user-visible output. The broker never relays the observer's final assistant text.

Each delivery has a stable ID. Delivery is at least once. A crash after harness injection but before acknowledgement can repeat the same delivery ID.

A whisper waits for the next harness delivery window. A queued message does not wait at all: the broker sends it as soon as the observer turn that produced it finishes.

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
  normalizeHookInput(input: unknown): Promise<HarnessEvent | null>;
  prepareObservation(
    event: HarnessEvent,
    cursor: SourceCursor | undefined,
  ): Promise<PreparedObservation>;
  formatWhispers(deliveries: DeliveryRecord[]): string;
  formatStatus(status: SessionStatus): string;
  contextChannel(nativeEvent: string): ContextChannel | null;
  harnessLettaIdentity?(event: HarnessEvent): HarnessLettaIdentity | null;
}
```

A harness that is itself a Letta agent answers `harnessLettaIdentity` with the coding agent's own agent and conversation IDs. A foreign harness omits the method, and its queued messages have nowhere to go.

## Context channels

A harness reads context out of a hook on one of two channels. `stdout` takes the text as written. `envelope` requires a JSON object naming the event. An event that carries no context at all returns null.

Sending the wrong channel fails silently. The harness drops the output, no context reaches the model, and the hook still exits zero. Nothing in the delivery path can see the difference.

That silence is what makes the acknowledgement order matter: the broker marks a delivery delivered after the hook emits it, so an ignored emit spends the whisper permanently. An adapter therefore claims an event only when it can say which channel that event reads, and widening the claim is a live-test change rather than a guess.

### Installed events follow the claim

A claimed channel is inert until the harness is configured to call the hook on that event. `subconscious install` therefore registers exactly the events the adapter can act on: every event whose channel is non-null, plus the observation events the adapter normalizes. Registering less strands a claim that can never fire; registering more spends a process launch on an event the adapter drops.

The installed list and the claimed channel are separate statements of the same intent, so they drift silently. Tests hold them to each other in both directions.

Tool-level events additionally take a matcher, and the matcher syntax is the harness's, not the installer's. Codex matches with an unanchored regex, where `.*` reaches every tool. Letta Code anchors its regex but special-cases the literal `"*"` before the regex path, which makes `"*"` the canonical every-tool value there. Simple events take no matcher at all.

Timeouts follow how often the event fires. Stop reads a transcript delta once per turn and gets ten seconds. The prompt boundaries get five. Tool hooks get three, because their budget is paid on every tool call rather than once per turn. Letta Code expresses all of these in milliseconds; Codex and Claude Code in seconds.

Installation is idempotent. A hook whose command carries the `subconscious hook` marker already present on an event means that event is registered, so a rerun after an upgrade adds nothing and rewrites nothing the user changed.

## Initial adapters

### Claude Code

Claude Code hooks provide the working directory, session ID, transcript path, and lifecycle events.

The adapter observes `SessionStart` and `Stop`, and delivers on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, and `PostToolUse`.

`SessionStart` and `UserPromptSubmit` read plain stdout. The tool events read only the JSON envelope. `PreCompact`, `Notification`, and `SessionEnd` discard hook output, so the adapter claims no channel for them.

Delivering on the tool events lets a whisper reach a turn already in progress instead of waiting for the next prompt. It costs a local broker round trip per tool call and never calls Letta, so the observer's cadence still follows observation rather than tool use.

Claude Code has no proven external queue API. `queue_message` stays unavailable until a live test proves one.

### Codex

Codex hooks and app-server events provide the working directory, thread ID, and lifecycle events.

The adapter must test passive hook context against Codex CLI 0.147.0 or later.

Codex 0.147.0 ships a `hookSpecificOutput` schema for `SessionStart`, `UserPromptSubmit`, `SubagentStart`, `PreToolUse`, and `PostToolUse`. The adapter delivers on the prompt boundaries and both tool events. `SubagentStart` reaches the subagent rather than the route that caused the observation, so it stays unclaimed. `PermissionRequest`, `PreCompact`, `PostCompact`, and `SessionEnd` carry no context field. The installer registers `SessionStart`, `UserPromptSubmit`, `Stop`, and both tool events in `$CODEX_HOME/hooks.json`, with `.*` as the tool matcher.

The adapter must test `thread/inject_items`, `turn/steer`, and `turn/start` against an active app-server thread. It exposes only the operations that pass.

### Letta Code

Letta Code reads context asymmetrically across the tool boundary. `PostToolUse` and `PostToolUseFailure` parse `additionalContext`, while `PreToolUse` consumes only `updatedInput`, so a whisper emitted before a tool call would be acknowledged and never seen. The adapter claims the two post-tool events and withholds `PreToolUse`. The installer registers `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, and `Stop` in the project's `.letta/settings.local.json`, with `"*"` as the tool matcher and `PreToolUse` absent.

`SessionStart` and `UserPromptSubmit` push hook stdout into context verbatim. An envelope on those events would inject its own JSON as literal text, so they stay on the stdout channel.

Letta Code hooks provide the working directory and structured turn fields. Session and prompt hooks include conversation identity. Current Stop input does not, and the hook executor strips conversation environment variables. The initial adapter therefore observes `SessionStart` and `UserPromptSubmit`. It skips a Stop event with no conversation ID rather than routing it through an agent-wide fallback. Completed-turn observation depends on a Letta Code hook contract that supplies the conversation ID.

The hook executor supports passive `additionalContext`. The adapter must still pass a real turn test.

A Letta Code session is a Letta agent in a Letta conversation, so `queue_message` needs no harness queue API. The adapter reports the coding agent's agent and conversation IDs from hook input, and the broker writes the message into that conversation through the Agent SDK. Claude Code and Codex are foreign harnesses whose hooks cannot start a turn, so they keep `queue_message` disabled.

## Durable state

The broker stores the following state:

- Project configuration identity and project root.
- Native harness session to Letta conversation routes.
- Last processed event ID or cursor for each harness session.
- In-flight event ID, Agent SDK `otid`, and reconciliation status.
- Pending whisper and queued-message deliveries.
- Delivery attempts, native receipts, acknowledgements, and deduplication keys.
- Agent ID, model, and Agent SDK connection identity.
- The observed coding agent's own Letta agent and conversation, when the harness has them.

State writes are atomic. One broker process owns writes. A stale process lock recovers without deleting pending deliveries.

### Retention

State is a single file that one writer rewrites on every mutation, so anything kept forever is paid for on every later write rather than once. The broker therefore bounds both what an observation record holds and how long it is held.

Retention runs on the writer's side of every state write. The file on disk is always the pruned one, and a `state.json` inherited from a build that never pruned is repaired by the first write a broker makes, which is the interrupted-observation recovery during start-up. Reading such a file never fails, and `subconscious status` still changes nothing.

An observation is never pruned while it is `queued`, `processing`, or `needs_reconciliation`. The first two are the broker's own work list. The third blocks every later observation on its route until a human runs `subconscious reconcile <event-id>`, so removing one would unblock the route silently and destroy the only handle the human has on it.

Everything else is pruned by age and by count, in two buckets:

- `processed` and `discarded` are history. Nothing acts on them again and status output only counts them. They are kept for 24 hours and at most 200 records.
- `failed` is an operator to-do, because `subconscious reconcile --retry` still accepts it. It is kept for 7 days and at most 200 records.

The caps apply per bucket, so a burst of successful turns cannot evict a failure nobody has looked at yet.

A delivery is pruned with the observation that produced it, and only once it is no longer actionable. A pending delivery that has not expired always survives, because a pending delivery must live until an adapter acknowledges it.

Stored event payloads are bounded twice. At intake the broker clamps the payload: long strings are truncated, and if the result is still over budget the largest remaining top-level fields are dropped and named, so the small identity fields adapters read by name always survive. When an observation reaches `processed` or `discarded` the payload is dropped entirely, because no code path can re-prepare from those two states and a retry from `failed` or `needs_reconciliation` still needs the event as sent.

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
- [x] Tool execution stays local unless `observer.sandbox` is true. An absent key runs exactly as it did before the flag existed.
- [x] A sandboxed project opens its session through the Cloud sandbox client and sends neither `cwd` nor session `env`.
- [x] A sandboxed session keeps the MemFS read tools and the broker-process delivery tools.
- [x] The observation prompt tells a sandboxed observer that the project root is not readable.
- [ ] A live turn proves that a sandboxed observer reads MemFS and delivers a whisper from the broker process.

### Delivery

- [x] A turn without a delivery tool call produces no harness output.
- [x] The broker discards ordinary assistant text from the observer.
- [x] `send_whisper` persists, deduplicates, expires, and acknowledges passive context.
- [x] `queue_message` is absent when configuration or adapter capability disables it.
- [x] An unsupported queue request returns a tool error without a whisper fallback.
- [x] Automated tests cover duplicate tool calls and broker restarts before acknowledgement.
- [x] Tests cover a crash after harness injection but before acknowledgement by reusing the same delivery ID.
- [x] A stale native session or active-turn ID never redirects a delivery to a replacement session.
- [x] `queue_message` reaches a Letta Code conversation through the Agent SDK without a hook lease.
- [x] The broker acknowledges a directly delivered queued message itself.
- [x] A queued message whose conversation changed owner is stale and is not redirected.
- [x] A failed direct delivery stays pending, records the reason, and is retried after a broker restart.
- [x] A project that has not set `queue_messages = true` sends nothing.
- [ ] A live turn proves that a queued message reaches a running Letta Code conversation.
- [x] The session status reaches the harness once per route and reports the agent, model, and delivery channels.
- [x] A second status claim on the same route returns nothing.

### Adapters

- [x] The Claude Code adapter proves project discovery, incremental observation, and passive whisper delivery in the real CLI.
- [x] The Claude Code adapter does not call Letta before each tool call. Tool-boundary delivery reaches the local broker only.
- [x] Each adapter names the context channel for every event it claims, and claims none it cannot name.
- [x] The installer registers every event an adapter claims a channel for, and no event it returns null for.
- [x] Tool-level hooks are installed with the harness's own every-tool matcher, and simple events are installed without one.
- [x] Rerunning `subconscious install` for a harness leaves exactly one Subconscious hook per event.
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
