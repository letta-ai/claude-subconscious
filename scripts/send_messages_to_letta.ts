#!/usr/bin/env npx tsx
/**
 * Send Messages to Letta Script
 * 
 * Sends Claude Code conversation messages to a Letta agent.
 * This script is designed to run as a Claude Code Stop hook.
 * 
 * Environment Variables:
 *   LETTA_API_KEY - API key for Letta authentication
 *   LETTA_AGENT_ID - Agent ID to send messages to
 * 
 * Hook Input (via stdin):
 *   - session_id: Current session ID
 *   - transcript_path: Path to conversation JSONL file
 *   - stop_hook_active: Whether stop hook is already active
 * 
 * Exit Codes:
 *   0 - Success
 *   1 - Non-blocking error
 * 
 * Log file: $TMPDIR/letta-claude-sync-$UID/send_messages.log
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getAgentId } from './agent_config.js';
import {
  LETTA_API_BASE,
  loadSyncState,
  saveSyncState,
  getOrCreateConversation,
  getSyncStateFile,
  spawnSilentWorker,
  SyncState,
  LogFn,
  getMode,
  getTempStateDir,
  getSdkToolsMode,
} from './conversation_utils.js';
import {
  readTranscript,
  formatMessagesForLetta,
  TranscriptMessage,
} from './transcript_utils.js';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const TEMP_STATE_DIR = getTempStateDir();
const LOG_FILE = path.join(TEMP_STATE_DIR, 'send_messages.log');

interface HookInput {
  session_id: string;
  transcript_path: string;
  stop_hook_active?: boolean;
  cwd: string;
  hook_event_name?: string;
}

/**
 * Ensure temp log directory exists
 */
function ensureLogDir(): void {
  if (!fs.existsSync(TEMP_STATE_DIR)) {
    fs.mkdirSync(TEMP_STATE_DIR, { recursive: true });
  }
}

/**
 * Log message to file
 */
function log(message: string): void {
  ensureLogDir();
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, logLine);
}

/**
 * Read hook input from stdin
 */
async function readHookInput(): Promise<HookInput> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('readable', () => {
      let chunk;
      while ((chunk = process.stdin.read()) !== null) {
        data += chunk;
      }
    });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error(`Failed to parse hook input: ${e}`));
      }
    });
    process.stdin.on('error', reject);
  });
}


interface SendResult {
  skipped: boolean;
}

/**
 * Send a message to a Letta conversation
 * Note: The conversations API streams responses, so we consume minimally
 * Returns { skipped: true } if conversation is busy (409), otherwise { skipped: false }
 */
async function sendMessageToConversation(
  apiKey: string,
  conversationId: string,
  role: string,
  text: string
): Promise<SendResult> {
  const url = `${LETTA_API_BASE}/conversations/${conversationId}/messages`;

  log(`Sending ${role} message to conversation ${conversationId} (${text.length} chars)`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: [
        {
          role: role,
          content: text,
        }
      ],
    }),
  });

  log(`  Response status: ${response.status}`);

  // Handle 409 Conflict gracefully - conversation is busy, skip and retry on next Stop
  if (response.status === 409) {
    log(`  Conversation busy (409) - skipping, will sync on next Stop`);
    return { skipped: true };
  }

  if (!response.ok) {
    const errorText = await response.text();
    log(`  Error response: ${errorText}`);
    throw new Error(`Letta API error (${response.status}): ${errorText}`);
  }

  // Consume the stream minimally - just read first chunk to confirm it started
  // The agent will continue processing in the background
  const reader = response.body?.getReader();
  if (reader) {
    try {
      const { value } = await reader.read();
      if (value) {
        const chunk = new TextDecoder().decode(value);
        log(`  Stream started, first chunk: ${chunk.substring(0, 100)}...`);
      }
    } finally {
      reader.cancel(); // Release the stream
    }
  }

  log(`  Message sent to conversation successfully`);
  return { skipped: false };
}

/**
 * Send batch of messages to Letta conversation (as a combined system message for context)
 * Returns { skipped: true } if conversation was busy, { skipped: false } otherwise
 */
async function sendBatchToConversation(
  apiKey: string,
  conversationId: string,
  sessionId: string,
  messages: Array<{role: string, text: string}>
): Promise<SendResult> {
  if (messages.length === 0) {
    log(`No messages to send`);
    return { skipped: false };
  }

  // Format as XML-structured transcript
  const transcriptEntries = messages.map(m => {
    const role = m.role === 'user' ? 'user' : m.role === 'assistant' ? 'claude_code' : 'system';
    // Escape XML special chars in text
    const escaped = m.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<message role="${role}">\n${escaped}\n</message>`;
  }).join('\n');

  const userMessage = `<claude_code_session_update>
<session_id>${sessionId}</session_id>

<transcript>
${transcriptEntries}
</transcript>

<instructions>
You may provide commentary or guidance for Claude Code. Your response will be added to Claude's context window on the next prompt. Use this to:
- Offer observations about the user's work
- Provide reminders or context from your memory
- Suggest approaches or flag potential issues
- Send async messages/guidance to Claude Code

Write your response as if speaking directly to Claude Code.
</instructions>
</claude_code_session_update>`;

  log(`Sending batch of ${messages.length} messages to conversation ${conversationId}`);
  return await sendMessageToConversation(apiKey, conversationId, 'user', userMessage);
}

/**
 * Main function
 */
async function main(): Promise<void> {
  log('='.repeat(60));
  log('send_messages_to_letta.ts started');

  const mode = getMode();
  log(`Mode: ${mode}`);
  if (mode === 'off') {
    log('Mode is off, exiting');
    process.exit(0);
  }
  
  // Get environment variables
  const apiKey = process.env.LETTA_API_KEY;

  log(`LETTA_API_KEY: ${apiKey ? 'set (' + apiKey.substring(0, 10) + '...)' : 'NOT SET'}`);

  if (!apiKey) {
    log('ERROR: LETTA_API_KEY not set');
    console.error('Error: LETTA_API_KEY must be set');
    process.exit(1);
  }

  try {
    // Get agent ID (from env, saved config, or auto-import)
    const agentId = await getAgentId(apiKey, log);
    log(`Using agent: ${agentId}`);
    // Read hook input
    log('Reading hook input from stdin...');
    const hookInput = await readHookInput();
    log(`Hook input received:`);
    log(`  session_id: ${hookInput.session_id}`);
    log(`  transcript_path: ${hookInput.transcript_path}`);
    log(`  stop_hook_active: ${hookInput.stop_hook_active}`);
    log(`  hook_event_name: ${hookInput.hook_event_name}`);
    log(`  cwd: ${hookInput.cwd}`);
    
    // Prevent infinite loops if stop hook is already active
    if (hookInput.stop_hook_active) {
      log('Stop hook already active, exiting to prevent loop');
      process.exit(0);
    }

    // Read transcript
    log(`Reading transcript from: ${hookInput.transcript_path}`);
    const messages = await readTranscript(hookInput.transcript_path, log);
    log(`Found ${messages.length} messages in transcript`);
    
    if (messages.length === 0) {
      log('No messages found, exiting');
      process.exit(0);
    }

    // Log message types found
    const typeCounts: Record<string, number> = {};
    for (const msg of messages) {
      const key = msg.type || msg.role || 'unknown';
      typeCounts[key] = (typeCounts[key] || 0) + 1;
    }
    log(`Message types: ${JSON.stringify(typeCounts)}`);

    // Load sync state (from durable storage)
    const state = loadSyncState(hookInput.cwd, hookInput.session_id, log);
    
    // Format new messages
    const newMessages = formatMessagesForLetta(messages, state.lastProcessedIndex, log);
    
    if (newMessages.length === 0) {
      log('No new messages to send after formatting');
      process.exit(0);
    }

    // Get or create conversation for this session
    const conversationId = await getOrCreateConversation(apiKey, agentId, hookInput.session_id, hookInput.cwd, state, log);
    log(`Using conversation: ${conversationId}`);

    // Save state now (with conversation ID) so it persists even if worker fails
    saveSyncState(hookInput.cwd, state, log);

    // Build the message payload (same format as sendBatchToConversation)
    const transcriptEntries = newMessages.map(m => {
      const role = m.role === 'user' ? 'user' : m.role === 'assistant' ? 'claude_code' : 'system';
      const escaped = m.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<message role="${role}">\n${escaped}\n</message>`;
    }).join('\n');

    const userMessage = `<claude_code_session_update>
<session_id>${hookInput.session_id}</session_id>

<transcript>
${transcriptEntries}
</transcript>

<instructions>
You may provide commentary or guidance for Claude Code. Your response will be added to Claude's context window on the next prompt. Use this to:
- Offer observations about the user's work
- Provide reminders or context from your memory
- Suggest approaches or flag potential issues
- Send async messages/guidance to Claude Code

Write your response as if speaking directly to Claude Code.
</instructions>
</claude_code_session_update>`;

    // Decide transport: SDK (with client-side tools) or legacy (raw API)
    const sdkToolsMode = getSdkToolsMode();
    log(`SDK tools mode: ${sdkToolsMode}`);

    const payloadFile = path.join(TEMP_STATE_DIR, `payload-${hookInput.session_id}-${Date.now()}.json`);
    const stateFile = getSyncStateFile(hookInput.cwd, hookInput.session_id);

    if (sdkToolsMode !== 'off') {
      // SDK mode: send via Letta Code SDK (Sub gets client-side tools)
      const sdkPayload = {
        agentId,
        sessionId: hookInput.session_id,
        message: userMessage,
        stateFile,
        newLastProcessedIndex: messages.length - 1,
        cwd: hookInput.cwd,
        sdkToolsMode,
      };
      fs.writeFileSync(payloadFile, JSON.stringify(sdkPayload), 'utf-8');
      log(`Wrote SDK payload to ${payloadFile}`);

      const workerScript = path.join(__dirname, 'send_worker_sdk.ts');
      const child = spawnSilentWorker(workerScript, payloadFile, hookInput.cwd);
      log(`Spawned SDK worker (PID: ${child.pid})`);
    } else {
      // Legacy mode: send via raw API (memory-only Sub)
      const legacyPayload = {
        apiKey,
        conversationId,
        sessionId: hookInput.session_id,
        message: userMessage,
        stateFile,
        newLastProcessedIndex: messages.length - 1,
      };
      fs.writeFileSync(payloadFile, JSON.stringify(legacyPayload), 'utf-8');
      log(`Wrote legacy payload to ${payloadFile}`);

      const workerScript = path.join(__dirname, 'send_worker.ts');
      const child = spawnSilentWorker(workerScript, payloadFile, hookInput.cwd);
      log(`Spawned legacy worker (PID: ${child.pid})`);
    }

    log('Hook completed (worker running in background)');

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`ERROR: ${errorMessage}`);
    if (error instanceof Error && error.stack) {
      log(`Stack trace: ${error.stack}`);
    }
    console.error(`Error sending messages to Letta: ${errorMessage}`);
    process.exit(1);
  }
}

// Run main function
main();
