# A Subconscious for Claude Code

***TL;DR***: Claude Code can store instructions in `CLAUDE.md`, but it doesn't reliably *learn* from the way you correct it. `claude-subconscious` is a plugin that adds a small observer loop: a Letta agent reads your session transcripts, extracts durable preferences, and syncs them into `.claude/CLAUDE.md` so the next session starts with better context.

Claude Code already gives you memory primitives: `CLAUDE.md`, `#`-memories, `/memory`, `/init`. In practice, though, there’s still a common failure mode: you correct the agent’s output, but that correction doesn’t automatically become a persistent preference.

A tiny example: you ask for a snippet and Claude writes

```js
function foo() {}
```

You change it to:

```js
const foo = () => {};
```

That’s a preference. But unless you remember to explicitly save it, you may end up making the same correction again later.

## What we built

`claude-subconscious` is a Claude Code plugin that connects your sessions to a Letta agent with persistent memory. The agent’s job is simple: observe the transcript, identify stable signals (like style conventions), and surface them in a format Claude Code naturally consumes.

Instead of treating memory as a file you manually curate, you get a lightweight learning loop that consolidates what's already present in your behavior. Some tools compress and embed your session history for retrieval. We took a different approach: a persistent agent that observes patterns and develops opinions about your work.

## How it works

- **Before each prompt:** sync the agent’s current guidance into `.claude/CLAUDE.md`.
- **After each response:** send the session transcript to the agent asynchronously.
- **No blocking:** the hook is fire-and-forget; you don’t wait for API calls.

By default, you can point any number of Claude Code sessions at the **same** Letta agent, so the agent’s memory accumulates across runs, and across a whole team if you want. If you prefer, you can also use a dedicated per-project agent instead of an org-wide one. Under the hood, this kind of shared, parallel usage is what the Letta **Conversations API** is designed for: https://docs.letta.com/guides/agents/conversations/

Over time, the agent forms a small set of “glanceable” memories (e.g., “prefer `const` over `function` in JS”), and keeps them up to date as your preferences evolve.

## Privacy & control (brief)

By default, the plugin sends your Claude Code session transcript to your Letta agent and writes the agent’s guidance into `.claude/CLAUDE.md`. You can disable it by uninstalling the plugin or unsetting `LETTA_API_KEY`. Memory lives with your Letta agent and can be inspected/edited in the Letta UI.

## Get started

```bash
/plugin install github:letta-ai/claude-subconscious
export LETTA_API_KEY="your-api-key"
```

- GitHub: https://github.com/letta-ai/claude-subconscious
- Get an API key: https://app.letta.com
- Letta: https://letta.com
