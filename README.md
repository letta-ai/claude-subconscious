# Letta Subconscious

A subconscious for Claude Code.

A [Letta](https://letta.com) agent watches your sessions, accumulates context, and whispers guidance back.

## What Is This?

Claude Code is fast and reactive but stateless - it forgets everything between sessions. Letta Subconscious adds a persistent layer underneath:

- **Your Letta agent observes** every Claude Code conversation
- **Accumulates patterns** across sessions, projects, and time
- **Whispers back** async guidance, reminders, and context

## How It Works

```
┌─────────────┐          ┌─────────────┐
│ Claude Code │◄────────►│ Letta Agent │
└─────────────┘          └─────────────┘
       │                        │
       │   Before each prompt   │
       │◄───────────────────────┤ Memory → CLAUDE.md
       │                        │
       │   After each response  │
       ├───────────────────────►│ Transcript → Agent
       │                        │
       │   Async (next prompt)  │
       │◄───────────────────────┤ Guidance → CLAUDE.md
```

## Installation

```bash
# Add the plugin
/plugin marketplace add letta-ai/letta-subconscious-plugin

# Install
/plugin install claude-subconscious@letta-ai/letta-subconscious-plugin
```

## Configuration

```bash
export LETTA_API_KEY="your-api-key"
export LETTA_AGENT_ID="agent-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Get your API key and agent ID from [app.letta.com](https://app.letta.com).

## What You'll See

Your Letta agent's memory and messages appear in `.claude/CLAUDE.md`:

```xml
<letta>
<letta_context>
**Subconscious Layer (Letta Agent)**

Agent: herald
Description: Research-focused AI exploring emergence and multi-agent systems.
View: https://app.letta.com/agents/agent-xxx

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
Working with Cameron on the letta-subconscious-plugin project.
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

## License

Apache-2.0
