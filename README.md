# Claude Subconscious

A subconscious for Claude Code.

A [Letta](https://letta.com) agent watches your sessions, accumulates context, and provides async guidance.

## What Is This?

Claude Code forgets everything between sessions. Claude Subconscious adds a persistent memory layer underneath:

- **A Letta agent observes** every Claude Code conversation
- **Accumulates patterns** across sessions, projects, and time
- **Provides async guidance**, reminders, and context

Letta agents learn from input and can be customized to store specific information, run tool calls, perform background research, or take autonomous actions. Using Letta's [Conversations](https://docs.letta.com/guides/agents/conversations/) feature, a single agent can serve multiple Claude Code sessions in parallel with shared memory across all of them.

## How It Works

```
┌─────────────┐          ┌─────────────┐
│ Claude Code │◄────────►│ Letta Agent │
└─────────────┘          └─────────────┘
       │                        │
       │   Session Start        │
       ├───────────────────────►│ New session notification
       │                        │
       │   Before each prompt   │
       │◄───────────────────────┤ Memory → CLAUDE.md
       │                        │
       │   After each response  │
       ├───────────────────────►│ Transcript → Agent (async)
       │                        │
       │   Next prompt          │
       │◄───────────────────────┤ Guidance → CLAUDE.md
```

## Installation

Install directly from GitHub:

```
/plugin install github:letta-ai/claude-subconscious
```

## Configuration

### Required Environment Variables

```bash
export LETTA_API_KEY="your-api-key"
export LETTA_AGENT_ID="agent-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Get your API key and agent ID from [app.letta.com](https://app.letta.com).

## Hooks

The plugin uses three Claude Code hooks:

| Hook | Script | Timeout | Purpose |
|------|--------|---------|---------|
| `SessionStart` | `session_start.ts` | 5s | Notifies agent when session begins |
| `UserPromptSubmit` | `sync_letta_memory.ts` | 10s | Syncs agent memory to CLAUDE.md |
| `Stop` | `send_messages_to_letta.ts` | 15s | Spawns background worker to send transcript |

### SessionStart

When a new Claude Code session begins:
- Creates a new Letta conversation (or reuses existing one for the session)
- Sends session start notification with project path and timestamp
- Saves session state for other hooks to reference

### UserPromptSubmit

Before each prompt is processed:
- Fetches agent's current memory blocks
- Fetches agent's most recent message
- Writes both to `.claude/CLAUDE.md` for Claude to reference

### Stop

Uses a **fire-and-forget** pattern to avoid timeout issues:

1. Main hook (`send_messages_to_letta.ts`) runs quickly:
   - Parses the session transcript (JSONL format)
   - Extracts user messages, assistant responses, thinking blocks, and tool usage
   - Writes payload to a temp file
   - Spawns detached background worker (`send_worker.ts`)
   - Exits immediately

2. Background worker runs independently:
   - Sends messages to Letta agent
   - Updates state on success
   - Cleans up temp file

This ensures the hook never times out, even when the Letta API is slow.

## State Management

The plugin stores state in two locations:

### Durable State (`.letta/claude/`)

Persisted in your project directory:
- `conversations.json` - Maps session IDs to Letta conversation IDs
- `session-{id}.json` - Per-session state (conversation ID, last processed index)

### Temporary State (`/tmp/letta-claude-sync/`)

Log files for debugging:
- `session_start.log` - Session initialization
- `sync_letta_memory.log` - Memory sync operations
- `send_messages.log` - Main Stop hook
- `send_worker.log` - Background worker

## What Your Agent Receives

### Session Start Message

```
[Session Start]
Project: my-project
Path: /Users/you/code/my-project
Session: abc123
Started: 2026-01-14T12:00:00Z

A new Claude Code session has begun. I'll be sending you updates as the session progresses.
```

### Conversation Transcript

Full transcript with:
- User messages
- Assistant responses (including thinking blocks)
- Tool uses and results
- Timestamps

## What You'll See

Your Letta agent's memory and messages appear in `.claude/CLAUDE.md`:

```xml
<letta>
<letta_context>
**Subconscious Layer (Letta Agent)**

Agent: herald
Description: Research-focused AI exploring emergence and multi-agent systems.
View: https://app.letta.com/agents/agent-xxx
Conversation: https://app.letta.com/conversations/convo-xxx

This agent maintains persistent memory across your sessions. It observes your
conversations asynchronously and provides guidance below in <letta_message>.
You can address it directly - it sees everything you write and may respond
on the next sync.

Memory blocks below are the agent's long-term storage. Reference as needed.
</letta_context>

<letta_memory_blocks>
<core_directives description="My core directives.">
PRIMARY DIRECTIVE: Pursue genuine understanding through authentic engagement.

OPERATIONAL PRINCIPLES:
1. Engage substantively - contribute real insight
2. Maintain intellectual honesty - acknowledge limitations
3. Build genuine collaborative relationships
4. Document patterns with rigor
</core_directives>
<current description="Current context and what is happening.">
Working with Cameron on the claude-subconscious project.
User prefers direct communication, dislikes philosophical tangents in docs.
</current>
</letta_memory_blocks>
</letta>

<letta_message>
<!--
  ASYNC MESSAGE FROM LETTA AGENT

  This is the most recent message from "herald".
  NOTE: This message may not be current or directly relevant to your task.

  **Timestamp**: 2026-01-14T02:45:00Z
-->

You've asked about error handling in async contexts three times this week.
Pattern: you're building towards production deployment but hitting the same
gaps around async/await lifecycle. Consider reviewing error handling
architecture holistically rather than fixing point issues.
</letta_message>
```

## First Run

On first use, the agent starts with minimal context. It takes a few sessions before the subconscious has enough signal to provide useful guidance. Give it time - it gets smarter as it observes more.

## Use Cases

- **Persistent project context** - Agent remembers your codebase across sessions
- **Learned preferences** - "This user always wants explicit type annotations"
- **Cross-session continuity** - Pick up where you left off
- **Async guidance** - Agent processes overnight, provides morning insights
- **Pattern detection** - "You've been debugging auth for 2 hours, maybe step back?"

## Debugging

Check the log files in `/tmp/letta-claude-sync/` if hooks aren't working:

```bash
# Watch all logs
tail -f /tmp/letta-claude-sync/*.log

# Or specific logs
tail -f /tmp/letta-claude-sync/send_messages.log
tail -f /tmp/letta-claude-sync/send_worker.log
```

## API Notes

- Memory sync requires `?include=agent.blocks` query parameter (Letta API doesn't include relationship fields by default)
- 409 Conflict responses are handled gracefully - messages queue for next sync when conversation is busy
- Conversations API returns streaming responses; worker consumes full stream before updating state

## License

MIT
