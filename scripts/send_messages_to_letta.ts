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

// Configuration
const LETTA_API_BASE = 'https://api.letta.com/v1';
const TEMP_STATE_DIR = '/tmp/letta-claude-sync';  // Temp state (logs, etc.)
const LOG_FILE = path.join(TEMP_STATE_DIR, 'send_messages.log');

// Durable storage in .letta directory
function getDurableStateDir(cwd: string): string {
  return path.join(cwd, '.letta', 'claude');
}

function getConversationsFile(cwd: string): string {
  return path.join(getDurableStateDir(cwd), 'conversations.json');
}

function getSyncStateFile(cwd: string, sessionId: string): string {
  return path.join(getDurableStateDir(cwd), `session-${sessionId}.json`);
}

interface HookInput {
  session_id: string;
  transcript_path: string;
  stop_hook_active?: boolean;
  cwd: string;
  hook_event_name?: string;
}

interface TranscriptMessage {
  type: string;
  role?: string;
  content?: string | Array<{ type: string; text?: string; thinking?: string }>;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string; thinking?: string }>;
  };
  tool_name?: string;
  tool_input?: any;
  tool_result?: any;
  timestamp?: string;
  uuid?: string;
}

interface SyncState {
  lastProcessedIndex: number;
  sessionId: string;
  conversationId?: string;
}

interface ConversationsMap {
  [sessionId: string]: string; // sessionId -> conversationId
}

interface Conversation {
  id: string;
  agent_id: string;
  created_at?: string;
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
 * Ensure durable state directory exists
 */
function ensureDurableStateDir(cwd: string): void {
  const dir = getDurableStateDir(cwd);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
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
 * Load sync state for this session
 */
function loadSyncState(cwd: string, sessionId: string): SyncState {
  const statePath = getSyncStateFile(cwd, sessionId);
  
  if (fs.existsSync(statePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      log(`Loaded state: lastProcessedIndex=${state.lastProcessedIndex}`);
      return state;
    } catch (e) {
      log(`Failed to load state: ${e}`);
    }
  }
  
  log(`No existing state, starting fresh`);
  return { lastProcessedIndex: -1, sessionId };
}

/**
 * Save sync state for this session
 */
function saveSyncState(cwd: string, state: SyncState): void {
  ensureDurableStateDir(cwd);
  const statePath = getSyncStateFile(cwd, state.sessionId);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
  log(`Saved state: lastProcessedIndex=${state.lastProcessedIndex}, conversationId=${state.conversationId}`);
}

/**
 * Load conversations mapping
 */
function loadConversationsMap(cwd: string): ConversationsMap {
  const filePath = getConversationsFile(cwd);
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
      log(`Failed to load conversations map: ${e}`);
    }
  }
  return {};
}

/**
 * Save conversations mapping
 */
function saveConversationsMap(cwd: string, map: ConversationsMap): void {
  ensureDurableStateDir(cwd);
  fs.writeFileSync(getConversationsFile(cwd), JSON.stringify(map, null, 2), 'utf-8');
}

/**
 * Create a new conversation for a session
 */
async function createConversation(apiKey: string, agentId: string): Promise<string> {
  const url = `${LETTA_API_BASE}/conversations?agent_id=${agentId}`;
  
  log(`Creating new conversation for agent ${agentId}`);
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create conversation: ${response.status} ${errorText}`);
  }

  const conversation: Conversation = await response.json();
  log(`Created conversation: ${conversation.id}`);
  return conversation.id;
}

/**
 * Get or create conversation for a session
 */
async function getOrCreateConversation(
  apiKey: string, 
  agentId: string, 
  sessionId: string,
  cwd: string,
  state: SyncState
): Promise<string> {
  // Check if we already have a conversation ID in state
  if (state.conversationId) {
    log(`Using existing conversation from state: ${state.conversationId}`);
    return state.conversationId;
  }

  // Check the conversations map
  const conversationsMap = loadConversationsMap(cwd);
  if (conversationsMap[sessionId]) {
    log(`Found conversation in map: ${conversationsMap[sessionId]}`);
    state.conversationId = conversationsMap[sessionId];
    return conversationsMap[sessionId];
  }

  // Create a new conversation
  const conversationId = await createConversation(apiKey, agentId);
  
  // Save to map and state
  conversationsMap[sessionId] = conversationId;
  saveConversationsMap(cwd, conversationsMap);
  state.conversationId = conversationId;
  
  return conversationId;
}

/**
 * Extract text content from a message
 */
function extractContent(msg: TranscriptMessage): string | null {
  // Check for content in msg.message.content first (Claude Code transcript format)
  const content = msg.message?.content ?? msg.content;
  
  if (typeof content === 'string') {
    return content;
  }
  
  if (Array.isArray(content)) {
    // Filter for text content, skip thinking blocks
    const textParts = content
      .filter(c => c.type === 'text' && c.text)
      .map(c => c.text);
    
    if (textParts.length > 0) {
      return textParts.join('\n');
    }
  }
  
  return null;
}

/**
 * Format messages for Letta
 */
function formatMessagesForLetta(messages: TranscriptMessage[], startIndex: number): Array<{role: string, text: string}> {
  const formatted: Array<{role: string, text: string}> = [];
  
  log(`Formatting messages from index ${startIndex + 1} to ${messages.length - 1}`);
  
  for (let i = startIndex + 1; i < messages.length; i++) {
    const msg = messages[i];
    
    log(`  Message ${i}: type=${msg.type}, role=${msg.role}`);
    
    // Handle user messages
    if (msg.type === 'user' || msg.type === 'human' || msg.role === 'user') {
      const content = extractContent(msg);
      if (content) {
        formatted.push({ role: 'user', text: content });
        log(`    -> Added user message (${content.length} chars)`);
      }
    }
    
    // Handle assistant messages
    else if (msg.type === 'assistant' || msg.role === 'assistant') {
      const content = extractContent(msg);
      if (content) {
        formatted.push({ role: 'assistant', text: content });
        log(`    -> Added assistant message (${content.length} chars)`);
      }
    }
    
    // Handle tool results
    else if (msg.type === 'tool_result' || msg.tool_result) {
      const result = msg.tool_result || msg.content;
      if (result) {
        const resultText = typeof result === 'string' ? result : JSON.stringify(result);
        // Truncate very long tool results
        const truncated = resultText.length > 2000 
          ? resultText.substring(0, 2000) + '... [truncated]' 
          : resultText;
        formatted.push({ 
          role: 'system', 
          text: `[Tool Result: ${msg.tool_name || 'unknown'}]\n${truncated}` 
        });
        log(`    -> Added tool result (${truncated.length} chars)`);
      }
    }
  }
  
  log(`Formatted ${formatted.length} messages total`);
  return formatted;
}

/**
 * Send a message to a Letta conversation
 * Note: The conversations API streams responses, so we consume minimally
 */
async function sendMessageToConversation(
  apiKey: string, 
  conversationId: string, 
  role: string, 
  text: string
): Promise<void> {
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
}

/**
 * Send batch of messages to Letta conversation (as a combined system message for context)
 */
async function sendBatchToConversation(
  apiKey: string,
  conversationId: string,
  sessionId: string,
  messages: Array<{role: string, text: string}>
): Promise<void> {
  if (messages.length === 0) {
    log(`No messages to send`);
    return;
  }

  // Format as a conversation summary
  const conversationSummary = messages.map(m => {
    const roleLabel = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Claude Code' : 'System';
    return `[${roleLabel}]: ${m.text}`;
  }).join('\n\n---\n\n');

  const systemMessage = `[Claude Code Session Update]
Session ID: ${sessionId}

The following conversation occurred in Claude Code:

${conversationSummary}

---

You may provide commentary or guidance for Claude Code. Your response will be added to Claude's context window (in the <letta_message> section of CLAUDE.md) on the next prompt. Use this to:
- Offer observations about the user's work
- Provide reminders or context from your memory
- Suggest approaches or flag potential issues
- Send async messages/guidance to Claude Code

Write your response as if speaking directly to Claude Code.`;

  log(`Sending batch of ${messages.length} messages to conversation ${conversationId}`);
  await sendMessageToConversation(apiKey, conversationId, 'system', systemMessage);
}

/**
 * Main function
 */
async function main(): Promise<void> {
  log('='.repeat(60));
  log('send_messages_to_letta.ts started');
  
  // Get environment variables
  const apiKey = process.env.LETTA_API_KEY;
  const agentId = process.env.LETTA_AGENT_ID;

  log(`LETTA_API_KEY: ${apiKey ? 'set (' + apiKey.substring(0, 10) + '...)' : 'NOT SET'}`);
  log(`LETTA_AGENT_ID: ${agentId || 'NOT SET'}`);

  if (!apiKey || !agentId) {
    log('ERROR: Missing required environment variables');
    console.error('Error: LETTA_API_KEY and LETTA_AGENT_ID must be set');
    process.exit(1);
  }

  try {
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
    const state = loadSyncState(hookInput.cwd, hookInput.session_id);
    
    // Format new messages
    const newMessages = formatMessagesForLetta(messages, state.lastProcessedIndex);
    
    if (newMessages.length === 0) {
      log('No new messages to send after formatting');
      process.exit(0);
    }

    // Get or create conversation for this session
    const conversationId = await getOrCreateConversation(apiKey, agentId, hookInput.session_id, hookInput.cwd, state);
    log(`Using conversation: ${conversationId}`);

    // Send to Letta conversation
    await sendBatchToConversation(apiKey, conversationId, hookInput.session_id, newMessages);
    
    // Update state (to durable storage)
    state.lastProcessedIndex = messages.length - 1;
    saveSyncState(hookInput.cwd, state);
    
    log('Completed successfully');

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
