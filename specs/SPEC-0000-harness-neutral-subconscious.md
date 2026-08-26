---
id: SPEC-0000
title: Harness-neutral Subconscious
status: implementing
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
- Any Letta agent can be attached. Subconscious does not replace its system prompt or seed application-owned behavioral memory.
- Subconscious behavior is introduced by one session-primer message. Later user messages contain only the new transcript observation.
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

Nothing waits on an observer turn. The broker sends a message and lets the agent answer if it chooses, and no part of the system is owed that answer. A turn therefore cannot hold a shutdown: the broker gives work in flight a short grace period, then exits and leaves whatever was running to be picked up as `needs_reconciliation` by the next start. Without that bound one stalled turn keeps the process, its start-up lock, and every later hook behind it.

A shutting-down broker still closes its listener before that grace period, so it stops answering before it exits. `subconscious stop` waits for the process to leave rather than for the socket to go quiet. Reading a failed ping as a stopped broker reports success and then fails to start, which leaves the session with no broker at all.

A hook never waits out broker start-up or replacement. The harness is on the other end of that wait, and it is short: Claude Code drops a tool-boundary hook after three seconds, so a hook that spends seconds acquiring a broker does not deliver a late whisper, it loses the boundary and the observation with it. A ready broker answers in about eighty milliseconds. When one is not ready, the hook starts or replaces it, gives it a quarter second, and otherwise emits nothing and returns. The cost is one skipped boundary, which is what a whisper is built to survive: it stays pending for the next one.

The fingerprint is the entry point's path and modification time. It catches a different install location, an upgrade, and a rebuild. It does not catch editing a source file the entry point does not import directly, so `subconscious restart` remains the explicit control.

Observation inside a turn coalesces instead of queueing. An adapter's `prepareObservation` reads the route's transcript delta when the observer turn runs, not when the event arrives, so two queued mid-turn observations on one route are redundant by construction: the first consumes the whole delta and the second reports an empty one. The broker therefore keeps at most one queued mid-turn record per route and folds every later tool result into it. A record that has already started running is not a fold target, which bounds a route to two mid-turn records at once, one running and one collecting.

A folded record keeps its ID, its `otid`, and its creation time while its event is replaced. The ID is the `otid` the record will send under and the key reconciliation searches Letta for, so rewriting it on every fold would change the identity of a record the broker has not sent yet.

A queued mid-turn record runs only once it clears both thresholds: how many tool results it stands for, and the quiet period since the route's last observer turn ended. No timer is involved. The readiness gate is re-read whenever the drain loop finishes, and every later tool call schedules that loop, so a ready record runs at the next tool boundary. A completed turn discards the queued mid-turn record it supersedes, because the `Stop` delta already contains everything that record was waiting to report. A broker restart discards whatever mid-turn records it finds queued: the turn they described ended with the process that was watching it, and their transcript delta is not lost, because the cursor never moved and the session's next turn boundary reports it.

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
# Optional. Absent means inherit the attached agent's default.
model = "letta/auto"

[model_overrides.claude_code]
# Optional per-harness refinement. Keys: claude_code, codex, letta_code, hermes.
model = "anthropic/claude-sonnet-5"
reasoning_effort = "high"
context_window_limit = 200000

[model_overrides.claude_code.settings]
temperature = 0.2

[delivery]
whispers = true
queue_messages = false

[observer]
instructions = "Focus on regressions and forgotten project decisions."
sandbox = false
mid_turn = false
mid_turn_min_tool_calls = 5
mid_turn_min_seconds = 90
```

`observer.sandbox` chooses where the observer's tools run. It is off by default, and an absent key means the tools run in the broker process against the project root, which is the only behavior earlier versions had.

When it is on, the runtime opens the session through a Cloud client that owns a Letta managed sandbox. Nothing the observer runs touches the user's machine. The cost is the project: a managed sandbox does not mount local paths, so the read tools reach the agent's MemFS projection and nothing else. The observer then works from MemFS and the observation text alone, and the observation prompt says so rather than letting it guess why a project path is missing.

The bundled toolset does not change. MemFS is a filesystem projection that travels with the agent, so `Read`, `LS`, `Glob`, and `Grep` are how the observer retrieves memory wherever it runs. Removing them would leave an observer that can write memory and never read it. The delivery tools execute in the broker process over the external-tool protocol, so they behave the same on both transports.

A sandboxed session sends no `cwd` and no session `env`. The project root does not exist in the sandbox, cloud transports ignore session env, and the Cloud client carries the credential instead.

`observer.mid_turn` chooses whether the observer sees tool boundaries inside a turn. It is off by default, and an absent key means the observer sees a session start, a prompt, and a completed turn, and says nothing during the minutes between the last two, which is the only behavior earlier versions had.

`mid_turn_min_tool_calls` and `mid_turn_min_seconds` are what make it affordable. The first is how many tool results one coalesced record must stand for before it earns a Letta turn. The second is the quiet period after the route's previous observer turn ended, which is the cadence control: it bounds how many observer turns one long coding-agent turn can cost, whatever the tool count does. Both are floors and both must pass. They default to five calls and ninety seconds, and a project that turns the feature on writes both out with the switch rather than only when they differ, because they are the whole cost control.

The thresholds are validated whether or not the switch is on, so a typo in a file with the feature off is still reported. A value that is not a whole number in range fails configuration loading and names the key. It does not fall back to the default: a throttle silently reverting to something the file does not say is worse than a startup error.

The CLI can create a dedicated observer agent when `agent_id` is absent. Agent creation uses `model: "letta/auto"` unless `--model` names another handle, plus MemFS and `baseTools: []`. It does not supply legacy memory block inputs, replace the standard Letta system prompt, or attach server-side tools. Without an explicit `--model`, the written configuration omits `model` entirely: a new observer inherits its own creation default, and a supplied agent keeps whatever it already uses.

The CLI does not attach optional external tools to a new observer agent.

The Subconscious agent is the Letta agent named by the project. The first message in each observer conversation explains that another agent is using Subconscious, that it is monitoring that agent's transcript, and that it may send guidance when it deems that important. Guidance must contain verified claims; incomplete evidence is stated as uncertainty or left silent. The primer also names available delivery tools, project context, and configured instructions. It does not prescribe an agent-wide identity or memory layout. Later messages contain only an escaped transcript observation, relying on the conversation to retain the one-time primer.

MemFS uses progressive disclosure. Compact facts needed in most turns belong under `system/`. Detailed decisions, explanations, incidents, and history belong under `reference/`. Each file has frontmatter that describes its contents and retrieval trigger. The observer updates or deletes stale information instead of preserving contradictions.

Agent SDK 0.7.6 applies an explicit project model as an override on the Subconscious conversation. Subconscious does not change unrelated conversations or the supplied agent's default model.

The `model` key is optional. A file without one, and without a matching override table, passes no session model option at all: the observer inherits its agent's default. `[model_overrides.<harness>]` tables refine this per harness with keys `claude_code`, `codex`, and `letta_code`; unknown harness keys fail configuration loading offline. Each table accepts a non-empty `model`, a `reasoning_effort` from the SDK tier set, a positive whole-number `context_window_limit`, and a JSON-compatible `settings` table without null values. `reasoning_effort` and `settings` are mutually exclusive in one table because their precedence over each other would be ambiguous.

Precedence is per harness: the harness override's model, else the project-wide `model`, else inheritance from the attached agent default. Fields an override omits fall back to the lower levels. Configuration loading validates structure only and never touches the network; a handle the backend does not know fails that observation clearly instead.

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

The adapter creates a stable event ID from native identity data when the harness supplies it. Every ID carries the native event name, so two kinds of event from one turn never collide. Claude Code and Codex use transcript markers, plus the prompt text on a prompt boundary, where the transcript has not yet moved. Letta Code uses a native turn or event ID when available. Current Letta Code Stop hooks have no turn ID, so that adapter uses a unique occurrence ID rather than silently dropping two identical turns. This fallback cannot deduplicate an external retry of the same hook process.

Adapters send bounded turn data. They do not repeatedly send the full transcript after every turn.

A `tool_result` event is a mid-turn boundary, and it carries route identity, the transcript path, the tool name, and whether the call reported an error. It does not carry the tool input or the tool output. Neither is read: the observation text comes from the transcript delta, which already contains the call and its result. Storing them would grow the state file on every tool call to hold what nothing looks at, and the broker rewrites that file on every mutation.

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
- Apply the resolved model selection: the harness override wins over the project model, and silence at both levels sends no `model` option so the conversation inherits the agent default.
- Pass `reasoningEffort` as a session option when the override names one; it re-applies on every turn through the same scoped path as `model`.
- Persist raw `settings` and `context_window_limit` onto the named Subconscious conversation through the management API, because they have no session-scoped route. An existing conversation is reconciled with `conversations.update` before the session opens, only when its recorded state differs from what the file now asks for; a removed override or a changed or removed reasoning effort sends explicit nulls to clear back to inheritance, since `update_model` can persist a tier inside the conversation settings.
- Never apply any of this outside a named Subconscious conversation, never on the supplied agent's default conversation, and never on the observed-agent queue delivery session.
- Initialize each session with `session.ready()` instead of fetching transcript history, and record the effective backend model it reports.
- Disable skill loading with `skillSources: []`.
- Disable automatic dreaming with `dreaming: { trigger: "off" }`.
- Set `toolset: { base: "none", include: bundledTools }`. The bundled list contains only read tools and `memory_apply_patch`. Letta Code scopes `memory_apply_patch` to the observer's MemFS repository.
- Pass the complete `allowedTools` list separately. It contains the bundled tools and enabled custom delivery tools. Custom Agent SDK tools must not appear in `toolset.include`; Letta Code rejects them as unknown bundled tools.
- Use `permissionMode: "standard"` with a callback that allows the list and denies every other client tool.
- Drain one `session.stream()` for each sent observation.
- Require a successful terminal `result` before the event cursor advances.
- Close the session after the turn.

The first observation for a harness session creates the named observer conversation explicitly with `conversations.create({ agentId, hidden: true, ...overrides })`, carrying every persistent override - or none of them when the file asks for pure inheritance - and then opens it with `resumeSession(conversation.id, options)`. The conversation therefore exists in its exact requested configuration before `ready()` initializes the first turn. The broker stores the returned conversation ID.

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

A whisper enters model context at the next supported harness boundary. Depending on the harness, that may be later in the current turn or on the next turn.

### `queue_message`

`queue_message` adds an actionable message that starts a new observed-agent turn.

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

The delivery session carries no model, no reasoning effort, no dreaming settings, and no client tools. A model or tier would rewrite the coding agent's own configuration, dreaming is applied persistently with scope both and would replace the agent's own reflection settings, and a client tool would make the broker process a device that executes the coding agent's tool calls. Sends into one observed agent's conversation are serialized per conversation, and a delivery whose record is already in flight joins that send instead of opening a second session for it.

The broker acknowledges a queued message itself, because no hook is present to acknowledge it. Agent SDK `send()` alone is not proof of persistence: the broker keeps the delivery session open, drains its stream, and requires a successful terminal result before acknowledgement. A missing or failed terminal result keeps the delivery pending. The delivery ID travels as the send OTID, so a retry after an unknown transport result deduplicates instead of posting the message twice.

If the conversation no longer belongs to the observed agent, the delivery is stale. It is never redirected into a replacement session. A transport failure leaves it pending with the reason recorded, and the next observer turn or broker start retries it.

### Delivery rule

No delivery tool call means no user-visible output. The broker never relays the observer's final assistant text.

Each delivery has a stable ID. Delivery is at least once. A crash after harness injection but before acknowledgement can repeat the same delivery ID.

A whisper waits for the next harness delivery window. A queued message does not wait at all: the broker sends it as soon as the observer turn that produced it finishes.

The session primer permits delivery when the Subconscious agent deems guidance important. Useful context includes:

- The user or harness addresses the observer directly.
- Project decisions and constraints related to the active task.
- Relevant file paths, commands, prior attempts, and known failures.
- Unresolved risks, corrections, and unfinished work.

The observer maximizes useful context rather than text volume. Progress summaries, praise, restatements, weak hunches, and unrelated facts do not qualify.

Observation processing remains nonblocking. Context prepared from one observation is available at the next safe prompt boundary.

## Session status

Install and start-up banners go to the terminal, so the harness never learns which Subconscious is attached to it. The assistant therefore cannot answer a question as basic as "which agent is watching this session?" without reading configuration files.

The broker exposes a minimal session identity once per route: the Subconscious agent ID and conversation ID. The hook claims it at the same prompt boundary as whispers and the adapter renders one compact `<subconscious_status ... />` element.

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

The adapter observes `SessionStart`, `UserPromptSubmit`, and `Stop`, and delivers on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, and `PostToolUse`. With `observer.mid_turn` enabled it also observes `PostToolUse`.

Observing the prompt is what puts the observer's turn beside the coding agent's rather than behind it. A prompt observation reports the `prompt` field from the hook input and nothing else. It does not read the transcript and does not advance the source cursor: at a prompt boundary that delta is the previous turn, which `Stop` already sent, and on the first prompt after a resume it is the whole transcript tail, because `SessionStart` sets no cursor. Leaving the cursor to `Stop` alone also keeps a turn's observation independent of which hook ran first. The prompt event ID carries the native event name and the prompt text, so a prompt never collides with the `Stop` of the same turn and two submissions never collapse into one.

`SessionStart` and `UserPromptSubmit` read plain stdout. The tool events read only the JSON envelope. `PreCompact`, `Notification`, and `SessionEnd` discard hook output, so the adapter claims no channel for them.

Delivering on the tool events lets a whisper reach a turn already in progress instead of waiting for the next prompt. It costs a local broker round trip per tool call and never calls Letta, so the observer's cadence still follows observation rather than tool use.

`PostToolUse` is the mid-turn boundary. `PreToolUse` is deliberately not observed: nothing has happened when it fires, so its transcript delta is the one the previous `PostToolUse` already reported. A mid-turn observation advances the same cursor as `Stop`, and it has to, because the delta it consumed is exactly the delta `Stop` would otherwise resend. Its event ID carries the tool name and the tool input, so two calls in one turn stay distinct even when the hook runs before the transcript is flushed and the marker has not moved. Two identical calls that also share a marker still collide, and that is the safe direction: the second folds into nothing rather than earning an observer turn. One record can stand for several calls, so the observation names the most recent one and leaves the transcript delta below it as the full account.

The hook skips a `PostToolUse` event when the project has not enabled `observer.mid_turn`. The broker refuses the event anyway, so this is not the check that enforces the flag; it keeps a project without the flag from paying a local round trip on every tool call to be told no.

Passive delivery is proven against the binary rather than against a description of it. `npm run test:e2e` places a whisper in a broker, runs a real `claude` process with the Subconscious hook registered on one boundary, and asserts the model reads the whisper back. The transcript names the boundary that carried it, which is what a wrong channel or a mismatched event name gets wrong. The hook under test reaches a broker of its own, so an installed plugin on the same machine cannot deliver the whisper first and hide the result.

Claude Code has no proven external queue API. `queue_message` stays unavailable until a live test proves one.

### Codex

Codex hooks and app-server events provide the working directory, thread ID, and lifecycle events.

The adapter must test passive hook context against Codex CLI 0.147.0 or later.

Codex 0.147.0 ships a `hookSpecificOutput` schema for `SessionStart`, `UserPromptSubmit`, `SubagentStart`, `PreToolUse`, and `PostToolUse`. The adapter delivers on the prompt boundaries and both tool events. `SubagentStart` reaches the subagent rather than the route that caused the observation, so it stays unclaimed. `PermissionRequest`, `PreCompact`, `PostCompact`, and `SessionEnd` carry no context field. The installer registers `SessionStart`, `UserPromptSubmit`, `Stop`, and both tool events in `$CODEX_HOME/hooks.json`, with `.*` as the tool matcher.

The adapter observes `SessionStart`, `UserPromptSubmit`, and `Stop`, and with `observer.mid_turn` enabled it also observes `PostToolUse` under the Claude Code mid-turn rules above. A prompt observation follows the Claude Code rule above: it reports the prompt from the hook input and leaves the transcript cursor to `Stop`. Codex 0.147.0's `user-prompt-submit.command.input` schema requires a `prompt` string and a `turn_id`, and its `stop.command.input` schema requires the same `turn_id`, so the prompt event ID carries the native event name, the turn ID, and the prompt text. A build that omits the prompt produces an observation that says so rather than an empty one.

The adapter must test `thread/inject_items`, `turn/steer`, and `turn/start` against an active app-server thread. It exposes only the operations that pass.

### Letta Code

Letta Code reads context asymmetrically across the tool boundary. `PostToolUse` and `PostToolUseFailure` parse `additionalContext`, while `PreToolUse` consumes only `updatedInput`, so a whisper emitted before a tool call would be acknowledged and never seen. The adapter claims the two post-tool events and withholds `PreToolUse`. The installer registers `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, and `Stop` in the project's `.letta/settings.local.json`, with `"*"` as the tool matcher and `PreToolUse` absent.

`SessionStart` and `UserPromptSubmit` push hook stdout into context verbatim. An envelope on those events would inject its own JSON as literal text, so they stay on the stdout channel.

Letta Code hooks provide the working directory and structured turn fields. Session and prompt hooks include conversation identity. Current Stop input does not, and the hook executor strips conversation environment variables. The initial adapter therefore observes `SessionStart` and `UserPromptSubmit`. It skips a Stop event with no conversation ID rather than routing it through an agent-wide fallback. Completed-turn observation depends on a Letta Code hook contract that supplies the conversation ID.

The hook executor supports passive `additionalContext`. The adapter must still pass a real turn test.

The adapter does not observe tool boundaries. Its completed-turn observation is still blocked on a hook contract that supplies the conversation ID, and it reads no transcript, so it has no delta a mid-turn observation could report. Mid-turn observation reaches Letta Code when completed-turn observation does.

A Letta Code session is a Letta agent in a Letta conversation, so `queue_message` needs no harness queue API. The adapter reports the coding agent's agent and conversation IDs from hook input, and the broker writes the message into that conversation through the Agent SDK. Claude Code and Codex are foreign harnesses whose hooks cannot start a turn, so they keep `queue_message` disabled.

### Hermes

Hermes 0.20.5 exposes config-driven shell hooks whose payloads carry `session_id`, the process `cwd`, and event-specific fields under `extra`. The adapter observes four events: `on_session_start`, `pre_llm_call`, `post_tool_call`, and `on_session_end`. Despite its name, `on_session_end` fires at the end of every turn, so it is the turn-stop boundary; tool failure is read from `post_tool_call`'s `status` field rather than a separate event.

Only `pre_llm_call` consumes hook output, on the bare `{"context": "..."}` shape, and it fires once per turn prologue. It is therefore both the prompt observation and the only whisper window: Hermes whispers are next-turn-only, and no mid-turn boundary can carry one. `post_tool_call` is registered as an observation-only boundary with no claimed channel, because its stdout is discarded at the fire site; registering it while claiming nothing is the honest statement of that asymmetry.

The canonical transcript is the SQLite store `<hermes-home>/state.db`, table `messages`; Hermes 0.20.5 has no live writer of per-session JSONL files. The adapter reads it through Node's built-in `node:sqlite` opened read-only, lazily imported so non-Hermes hooks never load it. The autoincrement row id is the cursor, paging is explicit (a backlog beyond one page reports truncation and finishes at the next boundary), and a cursor above the session's own maximum id — meaning the store was pruned or replaced — resets to replay that session instead of hanging forever.

Because one global broker may have been started by any harness, the broker's environment proves nothing about which Hermes profile owns an event. The hook subprocess stamps its resolved HERMES_HOME into every payload, and every later transcript read uses that per-event path. Profile resolution mirrors upstream `_apply_profile_override`: a HERMES_HOME whose immediate parent is named `profiles` is final; any other value still follows `<root>/active_profile`.

The installer edits the active profile's `config.yaml` textually so user comments survive byte-for-byte, deduplicates per `(event, exact command)` so unrelated hooks on the same event are preserved, refuses flow-shaped `hooks:` blocks rather than corrupting them, and seeds exactly the four consent allowlist entries in `shell-hooks-allowlist.json` without touching `hooks_auto_accept`. A malformed or unreadable allowlist is reported, never overwritten. Capabilities: passive context yes, queued messages no, transcript file.

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

The observation cursor advances only after the Agent SDK turn succeeds. A delivery remains pending until its adapter acknowledges it.

If a failure occurs after `send()` can have reached the runtime, the broker marks the event `needs_reconciliation`. Later observations on that route stay queued. `subconscious reconcile <event-id> --retry` checks recent Letta conversations for the `otid` before it retries. If the `otid` exists, the broker binds the route to that conversation and requires explicit discard after inspection. `--discard` releases the route without another observer turn.

One route maps one project configuration, Letta agent, harness type, and native harness session to one persistent Letta conversation.

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
- [x] `queued`, `processing`, and `needs_reconciliation` observations survive retention at any age and any record count.
- [x] Resolved observation history is bounded by both an age cap and a count cap.
- [x] A failed observation outlives resolved history, and a burst of successful turns cannot evict it.
- [x] Retention removes an observation from `observationOrder` whenever it removes the record.
- [x] A pending unexpired delivery survives the pruning of the observation that produced it.
- [x] An oversized `state.json` from an earlier build loads without error and is pruned by the first write the broker makes.
- [x] An unbounded harness payload is clamped before it is stored, and the identity fields adapters read by name survive the clamp.
- [x] A `processed` or `discarded` observation stores no payload.
- [x] The drain loop selects the next observation without copying the whole state.
- [x] Mid-turn observation stays off unless a project enables it, and the broker refuses a tool boundary from a project that has not.
- [x] A burst of tool calls on one route costs at most two observer turns, and the resulting records account for every tool call the harness reported.
- [x] A queued mid-turn record runs only after it clears both the tool-count and the quiet-period threshold.
- [x] A completed turn discards the queued mid-turn record it supersedes, whether or not the project still enables the feature.
- [x] A broker restart discards queued mid-turn records instead of running them against a turn that has already ended.
- [x] No timer schedules a mid-turn observation. The readiness gate is re-read by the drain loop alone.
- [x] A mid-turn threshold that is not a whole number in range fails configuration loading and names the key.

### Agent SDK

- [x] Production code imports only `@letta-ai/letta-agent-sdk` for Letta operations.
- [x] Production code contains no direct `/v1/` Letta requests.
- [x] New observer agents use `letta/auto` and MemFS.
- [x] New observer agents do not create or attach legacy memory blocks.
- [x] New observer agents keep the standard Letta system prompt.
- [x] Any existing Letta agent can be attached without changing its system prompt or default model.
- [x] A configuration without a `model` key loads, and the runtime sends no session model option for it.
- [x] Per-harness override tables parse, validate offline against the known harness keys and value shapes, and round-trip through the formatter.
- [x] Precedence resolves per harness: harness override above project `model` above agent-default inheritance.
- [x] The runtime creates each fresh observer conversation with its full override payload through `conversations.create`, then resumes it by conversation ID before the first turn.
- [x] The runtime persists raw settings and context-window overrides onto the named Subconscious conversation with `conversations.update` and clears them back to inheritance when the file stops naming them, including a reasoning tier left persisted by a previous turn.
- [x] A changed override updates the existing conversation in place; no route key or conversation is forked by a model change.
- [x] The queue delivery session carries neither a model nor a reasoning effort nor any persisted override.
- [x] The session primer lists only delivery tools available for that session and never instructs the agent to call a missing tool.
- [x] Observation and project-instruction text are escaped inside explicit data boundaries.
- [x] The first observer-conversation message primes the Subconscious role without forcing a delivery.
- [x] Later messages contain only the new transcript observation and do not repeat the primer, tool explanation, project root, or project instructions.
- [x] The observer prepares context for the next safe prompt boundary without blocking the current turn.
- [x] `tests/e2e/local-tools.e2e.test.ts` proves in a live turn that the observer can read a configured project file through the local App Server.
- [x] `tests/e2e/local-tools.e2e.test.ts` proves in the same live turn that custom delivery tools execute in the broker process.
- [x] The runtime drains and checks the terminal `result` for every observation.
- [x] The runtime uses `toolset: { base: "none" }`, includes only bundled observer tools, and passes the complete bundled-plus-custom `allowedTools` list separately.
- [x] The client tool allowlist excludes shell, project mutation, delegation, interactive, and worktree tools.
- [x] The permission callback denies every client tool outside the allowlist.
- [x] The CLI reports attached server-side agent tools separately from the client tool allowlist.
- [x] Tool execution stays local unless `observer.sandbox` is true. An absent key runs exactly as it did before the flag existed.
- [x] A sandboxed project opens its session through the Cloud sandbox client and sends neither `cwd` nor session `env`.
- [x] A sandboxed session keeps the MemFS read tools and the broker-process delivery tools.
- [x] The observation prompt tells a sandboxed observer that the project root is not readable.
- [x] Mid-turn transcript observations use the same minimal data boundary as every other post-primer observation.
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
- [x] The broker drains a directly delivered queued-message turn and acknowledges it only after a successful terminal result.
- [x] A queued message whose conversation changed owner is stale and is not redirected.
- [x] A failed direct delivery stays pending, records the reason, and is retried after a broker restart.
- [x] A project that has not set `queue_messages = true` sends nothing.
- [x] A live turn proves that a queued message reaches a running Letta Code conversation.
- [x] The session status reaches the harness once per route as one compact identity element.
- [x] A second status claim on the same route returns nothing.
- [x] A real `claude` process reads a whisper back verbatim, at a prompt boundary and at a tool boundary, and the session transcript names the boundary that carried it.
- [x] A whisper whose only registered boundary is one Claude Code discards stays pending, proven against a real `claude` process.
- [x] The end-to-end suite isolates itself from an installed Subconscious, so a developer's own plugin cannot deliver the whisper under test.
- [x] A whisper reaches Claude Code through the real hook, on the channel each boundary reads, in tests that assert on the emitted bytes.
- [x] The envelope names the boundary that carried it, on both tool events.
- [x] A status and a whisper that land on the same boundary are emitted as one object.
- [x] A whisper an event cannot carry stays pending for a boundary that can.
- [x] A hook that fails while writing leaves the whisper pending and delivers it at the next boundary.
- [x] A whisper reaches only the session that earned it, and no whisper leaves a directory no project configures.
- [x] A shutting-down broker finishes an observer turn already in flight, and its socket closes first, so stopping waits for the process rather than for the ping.

### Adapters

- [x] The Claude Code adapter proves project discovery, incremental observation, and passive whisper delivery in the real CLI.
- [x] The Claude Code adapter does not call Letta before each tool call. Tool-boundary delivery reaches the local broker only.
- [x] A hook against a ready broker costs well under the tightest harness budget, and a hook against a missing or stale one gives up rather than spending that budget.
- [x] Shutting down does not wait on an observer turn.
- [x] Each adapter names the context channel for every event it claims, and claims none it cannot name.
- [x] The installer registers every event an adapter claims a channel for, and no event it returns null for.
- [x] Tool-level hooks are installed with the harness's own every-tool matcher, and simple events are installed without one.
- [x] Rerunning `subconscious install` for a harness leaves exactly one Subconscious hook per event.
- [ ] The Codex adapter proves project discovery and incremental observation in the real CLI.
- [x] The Codex adapter exposes only live-tested passive and queue capabilities.
- [ ] The Letta Code adapter proves passive delivery through a real turn before release.
- [x] Each adapter reports unsupported capabilities without fallback behavior.
- [x] Every adapter observes the user's prompt at submission, so the observation runs beside the turn that answers it rather than after it.
- [x] A prompt observation carries the prompt text from the hook input, stays bounded, and leaves the transcript cursor unchanged.
- [x] A prompt event ID never matches the `Stop` event ID of the same turn, and two different prompts produce two IDs.
- [x] A prompt hook that carries no prompt text produces a labelled observation rather than an error or an empty one.
- [x] A `tool_result` event carries route and tool identity only, never the tool input or the tool output.
- [x] Adapters observe `PostToolUse` and not `PreToolUse`, and a mid-turn observation advances the same transcript cursor as the completed turn.
- [x] Two tool calls in one turn produce two event IDs even when the transcript marker has not moved.
- [x] A live session proves that a mid-turn whisper reaches the coding agent at a tool boundary inside the turn.

### Product validation

- [x] `subconscious status` runs without a Letta credential and does not change state.
- [x] Default status output shows broker health, the current project and observer, active work, pending whispers, and actionable failures.
- [x] Historical route output requires detail mode. Complete route and tool metadata requires JSON mode.
- [x] The package install test runs adapters from an unrelated working directory.
- [x] Tests cover two projects with different configurations under one parent directory.
- [x] Tests cover two harness sessions that share one observer agent.
- [x] Tests prove that shared-agent turns serialize against one MemFS repository.
- [x] A live acceptance test uses `letta/auto` and verifies the exact conversation route without changing the supplied agent's default model.
- [x] The runtime initializes sessions with `session.ready()` and records the effective backend model on the route instead of fetching transcript history.
- [x] Route and status data report the requested model, its source (`harness`, `project`, or `agent_default`), the reasoning effort, and the effective model, while the injected session status element stays compact.
- [x] The repository's full check command validates specs, types, formatting, tests, and package contents.
- [x] The end-to-end suite runs from its own command, and fails rather than skips when the `claude` binary or the build is missing.

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
