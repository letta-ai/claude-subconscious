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
 * Log file: /tmp/letta-claude-sync/send_messages.log
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { getAgentId } from './agent_config.js';
import {
  LETTA_API_BASE,
  loadSyncState,
  saveSyncState,
  getOrCreateConversation,
  getSyncStateFile,
  SyncState,
  LogFn,
} from './conversation_utils.js';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Windows compatibility: npx needs to be npx.cmd on Windows
const NPX_CMD = process.platform === 'win32' ? 'npx.cmd' : 'npx';

// Configuration
const TEMP_STATE_DIR = '/tmp/letta-claude-sync';  // Temp state (logs, etc.)
const LOG_FILE = path.join(TEMP_STATE_DIR, 'send_messages.log');

interface HookInput {
  session_id: string;
  transcript_path: string;
  stop_hook_active?: boolean;
  cwd: string;
  hook_event_name?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;        // tool name for tool_use
  id?: string;          // tool_use_id
  input?: any;          // tool input
  tool_use_id?: string; // for tool_result
  content?: string;     // tool result content
  is_error?: boolean;   // tool error flag
}

interface TranscriptMessage {
  type: string;
  role?: string;
  content?: string | ContentBlock[];
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
  tool_name?: string;
  tool_input?: any;
  tool_result?: any;
  timestamp?: string;
  uuid?: string;
  // Summary message fields
  summary?: string;
  // System message fields
  subtype?: string;
  stopReason?: string;
  // File history fields
  snapshot?: {
    trackedFileBackups?: Record<string, any>;
  };
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

/**
 * Read transcript JSONL file and parse messages
 */
async function readTranscript(transcriptPath: string): Promise<TranscriptMessage[]> {
  if (!fs.existsSync(transcriptPath)) {
    log(`Transcript file not found: ${transcriptPath}`);
    return [];
  }

  const messages: TranscriptMessage[] = [];
  const fileStream = fs.createReadStream(transcriptPath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    if (line.trim()) {
      try {
        messages.push(JSON.parse(line));
      } catch (e) {
        log(`Failed to parse transcript line: ${e}`);
      }
    }
  }

  return messages;
}

/**
 * Extract different content types from a message
 */
interface ExtractedContent {
  text: string | null;
  thinking: string | null;
  toolUses: Array<{ name: string; input: any }>;
  toolResults: Array<{ toolName: string; content: string; isError: boolean }>;
}

function extractAllContent(msg: TranscriptMessage): ExtractedContent {
  const result: ExtractedContent = {
    text: null,
    thinking: null,
    toolUses: [],
    toolResults: [],
  };

  const content = msg.message?.content ?? msg.content;

  if (typeof content === 'string') {
    result.text = content;
    return result;
  }

  if (Array.isArray(content)) {
    const textParts: string[] = [];
    const thinkingParts: string[] = [];

    for (const block of content) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      } else if (block.type === 'thinking' && block.thinking) {
        thinkingParts.push(block.thinking);
      } else if (block.type === 'tool_use' && block.name) {
        result.toolUses.push({
          name: block.name,
          input: block.input,
        });
      } else if (block.type === 'tool_result') {
        const resultContent = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content);
        result.toolResults.push({
          toolName: block.tool_use_id || 'unknown',
          content: resultContent,
          isError: block.is_error || false,
        });
      }
    }

    if (textParts.length > 0) {
      result.text = textParts.join('\n');
    }
    if (thinkingParts.length > 0) {
      result.thinking = thinkingParts.join('\n');
    }
  }

  return result;
}

/**
 * Truncate text to a maximum length
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '... [truncated]';
}

/**
 * Format messages for Letta with rich context
 */
function formatMessagesForLetta(messages: TranscriptMessage[], startIndex: number): Array<{role: string, text: string}> {
  const formatted: Array<{role: string, text: string}> = [];
  const toolNameMap: Map<string, string> = new Map(); // tool_use_id -> tool_name

  log(`Formatting messages from index ${startIndex + 1} to ${messages.length - 1}`);

  for (let i = startIndex + 1; i < messages.length; i++) {
    const msg = messages[i];

    log(`  Message ${i}: type=${msg.type}`);

    // Handle summary messages
    if (msg.type === 'summary' && msg.summary) {
      formatted.push({
        role: 'system',
        text: `[Session Summary]: ${msg.summary}`,
      });
      log(`    -> Added summary`);
      continue;
    }

    // Skip file-history-snapshot and system messages (internal)
    if (msg.type === 'file-history-snapshot' || msg.type === 'system') {
      continue;
    }

    // Handle user messages
    if (msg.type === 'user') {
      const extracted = extractAllContent(msg);

      // User text input
      if (extracted.text) {
        formatted.push({ role: 'user', text: extracted.text });
        log(`    -> Added user message (${extracted.text.length} chars)`);
      }

      // Tool results (these come in user messages)
      for (const toolResult of extracted.toolResults) {
        const toolName = toolNameMap.get(toolResult.toolName) || toolResult.toolName;
        const prefix = toolResult.isError ? '[Tool Error' : '[Tool Result';
        const truncatedContent = truncate(toolResult.content, 1500);
        formatted.push({
          role: 'system',
          text: `${prefix}: ${toolName}]\n${truncatedContent}`,
        });
        log(`    -> Added tool result for ${toolName} (error: ${toolResult.isError})`);
      }
    }

    // Handle assistant messages
    else if (msg.type === 'assistant') {
      const extracted = extractAllContent(msg);

      // Track tool names for later result mapping
      for (const toolUse of extracted.toolUses) {
        if (toolUse.input?.id) {
          toolNameMap.set(toolUse.input.id, toolUse.name);
        }
      }

      // Assistant thinking (summarized)
      if (extracted.thinking) {
        const truncatedThinking = truncate(extracted.thinking, 500);
        formatted.push({
          role: 'assistant',
          text: `[Thinking]: ${truncatedThinking}`,
        });
        log(`    -> Added thinking (${extracted.thinking.length} chars, truncated to 500)`);
      }

      // Tool calls
      for (const toolUse of extracted.toolUses) {
        // Format tool input concisely
        let inputSummary = '';
        if (toolUse.input) {
          if (toolUse.name === 'Read' && toolUse.input.file_path) {
            inputSummary = toolUse.input.file_path;
          } else if (toolUse.name === 'Edit' && toolUse.input.file_path) {
            inputSummary = toolUse.input.file_path;
          } else if (toolUse.name === 'Write' && toolUse.input.file_path) {
            inputSummary = toolUse.input.file_path;
          } else if (toolUse.name === 'Bash' && toolUse.input.command) {
            inputSummary = truncate(toolUse.input.command, 100);
          } else if (toolUse.name === 'Glob' && toolUse.input.pattern) {
            inputSummary = toolUse.input.pattern;
          } else if (toolUse.name === 'Grep' && toolUse.input.pattern) {
            inputSummary = toolUse.input.pattern;
          } else if (toolUse.name === 'WebFetch' && toolUse.input.url) {
            inputSummary = toolUse.input.url;
          } else if (toolUse.name === 'WebSearch' && toolUse.input.query) {
            inputSummary = toolUse.input.query;
          } else if (toolUse.name === 'Task' && toolUse.input.description) {
            inputSummary = toolUse.input.description;
          } else {
            inputSummary = truncate(JSON.stringify(toolUse.input), 100);
          }
        }

        formatted.push({
          role: 'assistant',
          text: `[Tool: ${toolUse.name}] ${inputSummary}`,
        });
        log(`    -> Added tool use: ${toolUse.name}`);
      }

      // Assistant text response
      if (extracted.text) {
        formatted.push({ role: 'assistant', text: extracted.text });
        log(`    -> Added assistant text (${extracted.text.length} chars)`);
      }
    }
  }

  log(`Formatted ${formatted.length} messages total`);
  return formatted;
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
    const messages = await readTranscript(hookInput.transcript_path);
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
    const newMessages = formatMessagesForLetta(messages, state.lastProcessedIndex);
    
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

    // Write payload to temp file for the worker
    const payloadFile = path.join(TEMP_STATE_DIR, `payload-${hookInput.session_id}-${Date.now()}.json`);
    const payload = {
      apiKey,
      conversationId,
      sessionId: hookInput.session_id,
      message: userMessage,
      stateFile: getSyncStateFile(hookInput.cwd, hookInput.session_id),
      newLastProcessedIndex: messages.length - 1,
    };
    fs.writeFileSync(payloadFile, JSON.stringify(payload), 'utf-8');
    log(`Wrote payload to ${payloadFile}`);

    // Spawn worker as detached background process
    const workerScript = path.join(__dirname, 'send_worker.ts');
    const isWindows = process.platform === 'win32';
    const child = spawn(NPX_CMD, ['tsx', workerScript, payloadFile], {
      detached: true,
      stdio: 'ignore',
      cwd: hookInput.cwd,
      env: process.env,
      // Windows requires shell: true for detached processes to work properly
      ...(isWindows && { shell: true, windowsHide: true }),
    });
    child.unref();
    log(`Spawned background worker (PID: ${child.pid})`);

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
