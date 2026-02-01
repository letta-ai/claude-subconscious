# Changelog

## [1.1.0] - 2026-01-28

### Added

- **PreToolUse hook for mid-workflow context injection** - New lightweight hook that checks for Letta agent updates before each tool use. Addresses "workflow drift" in long workflows by injecting new messages and memory block diffs mid-stream. Silent no-op if nothing changed.

- **Letta Code GitHub Action** - `@letta-code` can now respond to issues and PRs in this repository.

- **LETTA_BASE_URL support** - Self-hosted Letta servers can now be configured via environment variable.

- **Windows compatibility** - Fixed `npx spawn ENOENT` error on Windows.

- **Linux tmpfs workaround** - Documented workaround for `EXDEV` error when `/tmp` is on a different filesystem.

### Changed

- **Session start sync** - CLAUDE.md now syncs at session start for fresh agent/conversation IDs.

- **Default model** - Changed default agent model to GLM 4.7 (free tier on Letta Cloud).

- **Automatic model detection** - Plugin now queries available models and auto-selects if configured model is unavailable.

### Fixed

- **Plugin install syntax** - Updated README with correct marketplace install commands.

- **Conversation message ordering** - Fixed message fetch to correctly show newest messages first.

- **Conversation URL** - Links now point to agent view with conversation query param.

### Security

- **Sanitized default agent** - Removed user-specific data from bundled `Subconscious.af` file.

---

## [1.0.0] - 2026-01-16

Initial release.

### Features

- Bidirectional sync between Claude Code and Letta agents
- Memory blocks sync to `.claude/CLAUDE.md`
- Session transcripts sent to Letta agent asynchronously
- Conversation isolation per Claude Code session
- Auto-import default Subconscious agent if no agent configured
- Memory block diffs shown on changes
- New messages from Letta agent injected into context

### Hooks

- `SessionStart` - Notify agent of new session
- `UserPromptSubmit` - Sync memory before each prompt
- `Stop` - Send transcript after each response
