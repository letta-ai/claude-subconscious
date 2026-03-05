# Running Letta Server Locally

This guide explains how to set up a local Letta server that starts on boot, allowing the Subconscious agent to operate against your own infrastructure instead of the hosted `api.letta.com`.

## Why Run Locally?

- **Data privacy**: All agent data stays on your machine
- **Offline capability**: Works without internet connection (for local models)
- **Custom models**: Use any models configured on your local server
- **No API costs**: When using local models (e.g., Ollama)

## Prerequisites

1. Install Letta CLI:
   ```bash
   pip install letta
   ```

2. Verify installation:
   ```bash
   letta server --help
   ```

## macOS: Launch Agent Setup

A Launch Agent ensures `letta server` starts automatically on boot.

### 1. Find Your Letta Binary Path

```bash
which letta
```

This will output something like `/usr/local/bin/letta` or `/opt/homebrew/bin/letta` (Apple Silicon).

### 2. Update the .plist File

Edit `scripts/com.letta.server.plist` and update the `ProgramArguments` path to match your `letta` binary location:

```xml
<key>ProgramArguments</key>
<array>
    <string>/usr/local/bin/letta</string>  <!-- Update this path -->
    <string>server</string>
    <string>--env-name</string>
    <string>local</string>
</array>
```

### 3. Install the Launch Agent

```bash
cp scripts/com.letta.server.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.letta.server.plist
```

### 4. Verify It's Running

```bash
launchctl list | grep letta
```

You should see `com.letta.server` in the output.

Check the server is responding:
```bash
curl http://localhost:8283/v1/health
```

### 5. Configure Claude Subconscious

Add to your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
export LETTA_BASE_URL="http://localhost:8283"
```

Reload your shell:
```bash
source ~/.zshrc  # or source ~/.bashrc
```

### 6. Restart Claude Code

The next time you start a Claude Code session, the hooks will connect to your local server instead of `api.letta.com`.

You'll see `Server: http://localhost:8283` in the startup splash.

## Managing the Service

### Stop the server
```bash
launchctl unload ~/Library/LaunchAgents/com.letta.server.plist
```

### Start the server
```bash
launchctl load ~/Library/LaunchAgents/com.letta.server.plist
```

### View logs
```bash
tail -f /tmp/letta-server.log
tail -f /tmp/letta-server.error.log
```

### Remove the service
```bash
launchctl unload ~/Library/LaunchAgents/com.letta.server.plist
rm ~/Library/LaunchAgents/com.letta.server.plist
```

## Linux: systemd Service

For Linux users, create a systemd user service:

### 1. Create Service File

Create `~/.config/systemd/user/letta-server.service`:

```ini
[Unit]
Description=Letta Server
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/letta server --env-name local
Restart=on-failure
StandardOutput=append:/tmp/letta-server.log
StandardError=append:/tmp/letta-server.error.log

[Install]
WantedBy=default.target
```

### 2. Enable and Start

```bash
systemctl --user enable letta-server
systemctl --user start letta-server
```

### 3. Check Status

```bash
systemctl --user status letta-server
```

### 4. Configure Environment

Add to `~/.bashrc` or `~/.zshrc`:

```bash
export LETTA_BASE_URL="http://localhost:8283"
```

## Troubleshooting

### Server won't start

Check logs:
```bash
cat /tmp/letta-server.error.log
```

Common issues:
- Port 8283 already in use
- Missing API keys for model providers
- Incorrect path to `letta` binary

### Hooks still connecting to api.letta.com

Verify `LETTA_BASE_URL` is set:
```bash
echo $LETTA_BASE_URL
```

Should output `http://localhost:8283`.

If not, ensure you've:
1. Added the export to your shell profile
2. Reloaded your shell (`source ~/.zshrc`)
3. Restarted Claude Code

### Agent not found

When switching from hosted to local, your agent won't exist on the local server. Either:

1. **Import your agent** from hosted Letta
2. **Create a new agent** and set `LETTA_AGENT_ID`
3. **Let auto-import create one** (remove `~/.letta/claude-subconscious/config.json`)

## Using Both Hosted and Local

You can switch between hosted and local by changing `LETTA_BASE_URL`:

```bash
# Use hosted
unset LETTA_BASE_URL
# or
export LETTA_BASE_URL="https://api.letta.com"

# Use local
export LETTA_BASE_URL="http://localhost:8283"
```

Use `direnv` to set different values per-project:

```bash
# .envrc in project directory
export LETTA_BASE_URL="http://localhost:8283"
export LETTA_AGENT_ID="agent-local-xxx"
```
