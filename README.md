# Claude Subconscious

A background agent that whispers to Claude Code. A [Letta](https://letta.com) agent that watches your sessions, reads your files, builds up memory over time, and whispers guidance back.

> [!IMPORTANT]
> Claude Subconscious is an experimental way to extend Claude Code (a closed source / black box agent) with the power of Letta's memory system, tool access, and context engineering.
>
> If you're looking for a coding agent that's memory-first, model agnostic, and fully open source, we recommend using [**Letta Code**](https://github.com/letta-ai/letta-code).

![evil claude](assets/evil-claude.jpeg)

## What Is This?

Claude Code forgets everything between sessions. Claude Subconscious is a second agent running underneath — watching, learning, and whispering back:

- **Watches** every Claude Code session transcript
- **Reads your codebase** — explores files with Read, Grep, and Glob while processing transcripts
- **Remembers** across sessions, projects, and time
- **Whispers guidance** — surfaces context, patterns, and reminders before each prompt
- **Never blocks** — runs in the background via the [Letta Code SDK](https://docs.letta.com/letta-code/sdk/)

Not just a memory layer — a background agent with real tool access that gets smarter the more you use it.

Using Letta's [Conversations](https://docs.letta.com/guides/agents/conversations/) feature, a single agent can serve multiple Claude Code sessions in parallel with shared memory across all of them.

## How It Works

After each response, the transcript is sent to a Letta agent via the Letta Code SDK. The agent reads files, searches the web, updates its memory — then whispers back before the next prompt. Nothing is written to CLAUDE.md.

```
┌─────────────┐          ┌──────────────────────────┐
│ Claude Code │◄────────►│ Letta Agent (background)  │
└─────────────┘          │                          │
       │                 │  Tools: Read, Grep, Glob │
       │                 │  Memory: persistent       │
       │                 │  Web: search, fetch       │
       │                 └──────────────────────────┘
       │                        │
       │   Session Start        │
       ├───────────────────────►│ New session notification
       │                        │
       │   Before each prompt   │
       │◄───────────────────────┤ Whispers guidance → stdout
       │                        │
       │   Before each tool use │
       │◄───────────────────────┤ Mid-workflow updates → stdout
       │                        │
       │   After each response  │
       ├───────────────────────►│ Transcript → SDK session (async)
       │                        │  ↳ Reads files, updates memory
```

## Installation

Install from GitHub:

```
/plugin marketplace add letta-ai/claude-subconscious
/plugin install claude-subconscious@claude-subconscious
```

### Updating

```
/plugin marketplace update
/plugin update claude-subconscious@claude-subconscious
```

### Install from Source

Clone the repository:

```bash
git clone https://github.com/letta-ai/claude-subconscious.git
cd claude-subconscious
npm install
```

Enable the plugin (from inside the cloned directory):

```
/plugin enable .
```

Or enable globally for all projects:

```
/plugin enable --global .
```

If running from a different directory, use the full path to the cloned repo.

### Linux: tmpfs Workaround

If plugin installation fails with `EXDEV: cross-device link not permitted`, your `/tmp` is likely on a different filesystem (common on Ubuntu, Fedora, Arch). Set `TMPDIR` to work around this [Claude Code bug](https://github.com/anthropics/claude-code/issues/14799):

```bash
mkdir -p ~/.claude/tmp
export TMPDIR="$HOME/.claude/tmp"
```

Add to your shell profile (`~/.bashrc` or `~/.zshrc`) to make permanent.

## Configuration

### Required

```bash
export LETTA_API_KEY="your-api-key"
```

Get your API key from [app.letta.com](https://app.letta.com).

### Optional

```bash
export LETTA_MODE="whisper"    # Default. Or "full" for blocks + messages, "off" to disable
export LETTA_AGENT_ID="agent-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
export LETTA_BASE_URL="http://localhost:8283"  # For self-hosted Letta
export LETTA_MODEL="anthropic/claude-sonnet-4-5"  # Model override
export LETTA_CONTEXT_WINDOW="1048576"             # Context window size (e.g. 1M tokens)
export LETTA_HOME="$HOME"      # Consolidate .letta state to ~/.letta/
export LETTA_SDK_TOOLS="read-only"       # Or "full", "off"
```

- `LETTA_MODE` - Controls what gets injected. `whisper` (default, messages only), `full` (blocks + messages), `off` (disable). See [Modes](#modes).
- `LETTA_AGENT_ID` - If not set, the plugin automatically imports a default "Subconscious" agent on first use.
- `LETTA_BASE_URL` - For self-hosted Letta servers. Defaults to `https://api.letta.com`.
- `LETTA_MODEL` - Override the agent's model. Optional - the plugin auto-detects and selects from available models. See [Model Configuration](#model-configuration) below.
- `LETTA_CONTEXT_WINDOW` - Override the agent's context window size (in tokens). Useful when `LETTA_MODEL` is set to a model with a large context window that differs from the server default. Example: `1048576` for 1M tokens.
- `LETTA_HOME` - Base directory for plugin state files. Creates `{LETTA_HOME}/.letta/claude/` for session data and conversation mappings. Defaults to current working directory. Set to `$HOME` to consolidate all state in one location.
- `LETTA_SDK_TOOLS` - Controls client-side tool access for the Subconscious agent. `read-only` (default), `full`, or `off`. See [SDK Tools](#sdk-tools).

### Modes

The `LETTA_MODE` environment variable controls what gets injected into Claude's context:

| Mode | What Claude sees | Use case |
|------|-----------------|----------|
| **`whisper`** (default) | Only messages from Sub | Lightweight — Sub speaks when it has something to say |
| **`full`** | Memory blocks + messages | Full context — blocks on first prompt, diffs after |
| **`off`** | Nothing | Disable hooks temporarily |

Subconscious **never writes to CLAUDE.md** in any mode. All content is injected via stdout into the prompt context. If you have an existing CLAUDE.md with `<letta>` content from an older version, it will be cleaned up automatically.

### Agent Resolution Order

1. **Environment variable** - `LETTA_AGENT_ID` if set
2. **Saved config** - `~/.letta/claude-subconscious/config.json` if exists
3. **Auto-import** - Imports bundled `Subconscious.af` agent, saves ID for future use

This means zero-config setup: just set `LETTA_API_KEY` and the plugin handles the rest.

### Multi-Project Usage

**One agent, many projects.** The Subconscious agent is stored globally at `~/.letta/claude-subconscious/config.json`. When you use the plugin in different repos, they all share the same agent brain.

```
~/.letta/claude-subconscious/config.json  →  ONE agent ID (shared brain)
                                               ↓
project-a/.letta/claude/                  →  Project A's conversation threads
project-b/.letta/claude/                  →  Project B's conversation threads
project-c/.letta/claude/                  →  Project C's conversation threads
```

The `.letta/claude/` directories in each project are **conversation bookkeeping** (mapping Claude Code sessions to Letta conversations), not separate agents. Memory blocks are shared across all projects.

To use a **different agent per project**, set `LETTA_AGENT_ID` in your shell or via [direnv](https://direnv.net/):

```bash
# .envrc in project directory
export LETTA_AGENT_ID="agent-xxx-for-this-project"
```

### Model Configuration

The plugin **automatically detects available models** on your Letta server and configures the agent appropriately:

1. **Queries available models** from your Letta server (`GET /v1/models/`)
2. **Checks if the agent's model is available** on that server
3. **Auto-selects a fallback** if the current model isn't available

#### Auto-Selection Priority

When the agent's model isn't available, the plugin selects from available models in this order:
1. `anthropic/claude-sonnet-4-5` (recommended - best for agents)
2. `openai/gpt-4.1-mini` (good balance, 1M context, cheap)
3. `anthropic/claude-haiku-4-5` (fast Claude option)
4. `openai/gpt-5.2` (flagship fallback)
5. `google_ai/gemini-3-flash` (Google's balanced option)
6. `google_ai/gemini-2.5-flash` (fallback)
7. `minimax/MiniMax-M2.7` (MiniMax flagship, 1M context)
8. `minimax/MiniMax-M2.7-highspeed` (MiniMax fast option)
9. First available model on the server

#### Manual Override

To specify a particular model, set `LETTA_MODEL`:

```bash
export LETTA_MODEL="anthropic/claude-sonnet-4-5"
```

The model handle format is `provider/model`. Common options:

| Provider | Example Models |
|----------|----------------|
| `openai` | `gpt-5.2`, `gpt-5-nano`, `gpt-4.1-mini` |
| `anthropic` | `claude-sonnet-4-5`, `claude-opus-4-5`, `claude-haiku-4-5` |
| `google_ai` | `gemini-3-flash`, `gemini-2.5-flash`, `gemini-2.5-pro` |
| `minimax` | `MiniMax-M2.7` (1M context, strong tool use), `MiniMax-M2.7-highspeed` |
| `zai` | `glm-5` (Letta Cloud default, free) |

If `LETTA_MODEL` is set but not available on the server, the plugin will warn you and fall back to auto-selection.

The default bundled agent uses `zai/glm-5` (free on Letta Cloud). For better tool usage and reasoning, consider switching to a stronger model. You can change the model at any time via the [Agent Development Environment](https://app.letta.com) (ADE) or by setting `LETTA_MODEL`.

**Note:** Ensure your Letta server has the appropriate API key configured for your chosen provider (e.g., `OPENAI_API_KEY` for OpenAI models).

## Default Subconscious Agent

When no agent is configured, the plugin auto-imports a bundled "Subconscious" agent designed specifically for this use case.

### What It Does

The default agent is a background agent that:

- **Reads your code** — uses Read, Grep, and Glob to explore your codebase while processing transcripts
- **Learns your preferences** from corrections, explicit statements, and patterns
- **Tracks project context** — architecture decisions, known gotchas, pending items
- **Provides guidance** via the `<letta_message>` block when it has something useful
- **Searches the web** — can look things up to augment its context

### Memory Blocks

The default agent Subconscious maintains 8 memory blocks:

| Block | Purpose |
|-------|---------|
| `core_directives` | Role definition and behavioral guidelines |
| `guidance` | Active guidance for the next session (syncs to Claude Code before each prompt) |
| `user_preferences` | Learned coding style, tool preferences, communication style |
| `project_context` | Codebase knowledge, architecture decisions, known gotchas |
| `session_patterns` | Recurring behaviors, time-based patterns, common struggles |
| `pending_items` | Unfinished work, explicit TODOs, follow-up items |
| `self_improvement` | Guidelines for evolving memory architecture over time |
| `tool_guidelines` | How to use available tools (memory, filesystem, web search) |

If you set an alternative agent using `LETTA_AGENT_ID`, your agent will use its existing memory architecture.

### Communication Style

Subconscious is configured to be:

- **Observational** - "I noticed..." not "You should..."
- **Concise** - Technical, no filler
- **Present but not intrusive** - Empty guidance is fine; it won't manufacture content

### Two-Way Communication

Claude Code can address the Subconscious agent directly in responses. The agent sees everything in the transcript and may respond on the next sync. It's designed for ongoing dialogue, not just one-way observation.

## Hooks

The plugin uses four Claude Code hooks:

| Hook | Script | Timeout | Purpose |
|------|--------|---------|---------|
| `SessionStart` | `session_start.ts` | 5s | Notifies agent, cleans up legacy CLAUDE.md |
| `UserPromptSubmit` | `sync_letta_memory.ts` | 10s | Injects memory + messages via stdout |
| `PreToolUse` | `pretool_sync.ts` | 5s | Mid-workflow updates via `additionalContext` |
| `Stop` | `send_messages_to_letta.ts` | 120s | Spawns SDK worker to send transcript (async) |

### SessionStart

When a new Claude Code session begins:
- Creates a new Letta conversation (or reuses existing one for the session)
- Sends session start notification with project path and timestamp
- Cleans up any legacy `<letta>` content from CLAUDE.md
- Saves session state for other hooks to reference

### UserPromptSubmit

Before each prompt is processed:
- Fetches agent's current memory blocks and messages
- In `full` mode: injects all blocks on first prompt, diffs on subsequent prompts
- In `whisper` mode: injects only messages from Sub

### PreToolUse

Before each tool use:
- Checks for new messages or memory changes since last sync
- If updates found, injects them via `additionalContext`
- Silent no-op if nothing changed

### SDK Tools

By default, the Subconscious agent now gets **client-side tool access** via the [Letta Code SDK](https://docs.letta.com/letta-code/sdk/). Instead of being limited to memory operations, Sub can read your files, search the web, and explore your codebase while processing transcripts.

**Configuration via `LETTA_SDK_TOOLS`:**

| Mode | Tools Available | Use Case |
|------|----------------|----------|
| `read-only` (default) | `Read`, `Grep`, `Glob`, `web_search`, `fetch_webpage` | Safe background research and file reading |
| `full` | All tools (Bash, Edit, Write, Task, etc.) | Full autonomy — Sub can make changes and spawn sub-agents |
| `off` | None (memory-only) | Listen-only — Sub processes transcripts but has no client-side tools |

In `full` mode, Sub can spawn sub-agents via the `Task` tool — dispatching parallel research or delegating work to other agents while Claude Code continues working.

> **Note:** Requires `@letta-ai/letta-code-sdk` (installed as a dependency).

### Stop

Uses an **async hook** pattern — runs in the background without blocking Claude Code:

1. Main hook (`send_messages_to_letta.ts`) runs quickly:
   - Parses the session transcript (JSONL format)
   - Extracts user messages, assistant responses, thinking blocks, and tool usage
   - Writes payload to a temp file
   - Spawns detached background worker
   - Exits immediately

2. Background worker (`send_worker_sdk.ts`) runs independently:
   - Opens a Letta Code SDK session, giving Sub client-side tools
   - Sub processes the transcript and can use Read/Grep/Glob to explore the codebase
   - Updates state on success
   - Cleans up temp file

The Stop hook runs as an async hook, so it never blocks Claude Code.

## State Management

The plugin stores state in two locations:

### Durable State (`.letta/claude/`)

Persisted in your project directory (this is **conversation bookkeeping**, not a separate agent - see [Multi-Project Usage](#multi-project-usage)):
- `conversations.json` - Maps Claude Code session IDs → Letta conversation IDs
- `session-{id}.json` - Per-session state (last processed index, cached conversation ID)

### Temporary State (`$TMPDIR/letta-claude-sync-$UID/`)

Log files for debugging:
- `session_start.log` - Session initialization
- `sync_letta_memory.log` - Memory sync operations
- `send_messages.log` - Main Stop hook
- `send_worker_sdk.log` - SDK background worker

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

## What Claude Sees

All content is injected via stdout — nothing is written to disk. What Claude receives depends on the mode.

### Messages (whisper + full mode)

Messages from your Subconscious agent are injected before each prompt:

```xml
<letta_message from="Subconscious" timestamp="2026-01-26T20:37:14+00:00">
You've asked about error handling in async contexts three times this week.
Consider reviewing error handling architecture holistically.
</letta_message>
```

### Memory Blocks (full mode only)

On the first prompt of a session, all memory blocks are injected:

```xml
<letta_context>
Subconscious agent "herald" is observing this session.
Supervise: https://app.letta.com/agents/agent-xxx?conversation=conv-xxx
</letta_context>

<letta_memory_blocks>
<user_preferences description="Learned coding style and preferences.">
Prefers explicit type annotations. Uses pnpm, not npm.
</user_preferences>
<project_context description="Codebase knowledge and architecture.">
Working on claude-subconscious plugin. TypeScript, ESM modules.
</project_context>
</letta_memory_blocks>
```

On subsequent prompts, only changed blocks are shown as diffs:

```xml
<letta_memory_update>
<pending_items status="modified">
- Phase 1 test harness complete
+ Release prep complete: README fixed, .gitignore updated
</pending_items>
</letta_memory_update>
```

## First Run

On first use, the agent starts with minimal context. It takes a few sessions before it has enough signal to provide useful guidance. Give it time — it reads your code, learns your patterns, and gets smarter the more it observes.

## Use Cases

- **Persistent project context** — Agent reads your codebase and remembers it across sessions
- **Learned preferences** — "This user always wants explicit type annotations"
- **Cross-session continuity** — Pick up where you left off, with full context
- **Background research** — Agent can search the web and read files while you work
- **Pattern detection** — "You've been debugging auth for 2 hours, maybe step back?"
- **Proactive codebase awareness** — Agent explores relevant files when it sees you working on a feature

## Debugging

Check the log files if hooks aren't working. The log directory is user-specific (`$TMPDIR/letta-claude-sync-$UID/`):

```bash
# Watch all logs (macOS/Linux)
tail -f /tmp/letta-claude-sync-$(id -u)/*.log

# Or specific logs
tail -f /tmp/letta-claude-sync-$(id -u)/send_messages.log
tail -f /tmp/letta-claude-sync-$(id -u)/send_worker_sdk.log
```

## API Notes

- Memory sync requires `?include=agent.blocks` query parameter (Letta API doesn't include relationship fields by default)
- All transcript delivery uses the [Letta Code SDK](https://docs.letta.com/letta-code/sdk/) — no raw API calls for message sending
- The SDK worker streams the agent's full response before updating state

## License

MIT
