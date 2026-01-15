#!/usr/bin/env npx tsx
/**
 * Session Start Hook Script
 *
 * Notifies Letta agent when a new Claude Code session begins.
 * This script is designed to run as a Claude Code SessionStart hook.
 *
 * Environment Variables:
 *   LETTA_API_KEY - API key for Letta authentication
 *   LETTA_AGENT_ID - Agent ID to send messages to
 *
 * Hook Input (via stdin):
 *   - session_id: Current session ID
 *   - cwd: Current working directory
 *   - hook_event_name: "SessionStart"
 *
 * Exit Codes:
 *   0 - Success
 *   1 - Non-blocking error
 *
 * Log file: /tmp/letta-claude-sync/session_start.log
 */

import * as fs from 'fs';
import * as path from 'path';

// Configuration
const LETTA_API_BASE = 'https://api.letta.com/v1';
const TEMP_STATE_DIR = '/tmp/letta-claude-sync';
const LOG_FILE = path.join(TEMP_STATE_DIR, 'session_start.log');

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name?: string;
}

interface ConversationsMap {
  [sessionId: string]: string;
}

interface Conversation {
  id: string;
  agent_id: string;
  created_at?: string;
}

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

/**
 * Ensure directories exist
 */
function ensureLogDir(): void {
  if (!fs.existsSync(TEMP_STATE_DIR)) {
    fs.mkdirSync(TEMP_STATE_DIR, { recursive: true });
  }
}

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
 * Save session state
 */
function saveSessionState(cwd: string, sessionId: string, conversationId: string): void {
  ensureDurableStateDir(cwd);
  const state = {
    sessionId,
    conversationId,
    lastProcessedIndex: -1,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(getSyncStateFile(cwd, sessionId), JSON.stringify(state, null, 2), 'utf-8');
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
 * Send session start message to Letta
 */
async function sendSessionStartMessage(
  apiKey: string,
  conversationId: string,
  sessionId: string,
  cwd: string
): Promise<void> {
  const url = `${LETTA_API_BASE}/conversations/${conversationId}/messages`;

  const projectName = path.basename(cwd);
  const timestamp = new Date().toISOString();

  const message = `[Session Start]
Project: ${projectName}
Path: ${cwd}
Session: ${sessionId}
Started: ${timestamp}

A new Claude Code session has begun. I'll be sending you updates as the session progresses.`;

  log(`Sending session start message to conversation ${conversationId}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: [{ role: 'system', content: message }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to send message: ${response.status} ${errorText}`);
  }

  // Consume stream minimally
  const reader = response.body?.getReader();
  if (reader) {
    try {
      await reader.read();
    } finally {
      reader.cancel();
    }
  }

  log(`Session start message sent successfully`);
}

/**
 * Main function
 */
async function main(): Promise<void> {
  log('='.repeat(60));
  log('session_start.ts started');

  const apiKey = process.env.LETTA_API_KEY;
  const agentId = process.env.LETTA_AGENT_ID;

  if (!apiKey || !agentId) {
    log('ERROR: Missing required environment variables');
    console.error('Error: LETTA_API_KEY and LETTA_AGENT_ID must be set');
    process.exit(1);
  }

  try {
    // Read hook input
    log('Reading hook input from stdin...');
    const hookInput = await readHookInput();
    log(`Hook input: session_id=${hookInput.session_id}, cwd=${hookInput.cwd}`);

    // Check if conversation already exists for this session
    const conversationsMap = loadConversationsMap(hookInput.cwd);

    let conversationId: string;
    if (conversationsMap[hookInput.session_id]) {
      // Reuse existing conversation
      conversationId = conversationsMap[hookInput.session_id];
      log(`Reusing existing conversation: ${conversationId}`);
    } else {
      // Create new conversation
      conversationId = await createConversation(apiKey, agentId);
      conversationsMap[hookInput.session_id] = conversationId;
      saveConversationsMap(hookInput.cwd, conversationsMap);
    }

    // Save session state
    saveSessionState(hookInput.cwd, hookInput.session_id, conversationId);

    // Send session start message
    await sendSessionStartMessage(apiKey, conversationId, hookInput.session_id, hookInput.cwd);

    log('Completed successfully');

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`ERROR: ${errorMessage}`);
    console.error(`Error in session start hook: ${errorMessage}`);
    process.exit(1);
  }
}

main();
