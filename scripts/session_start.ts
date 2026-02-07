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
import * as os from 'os';
import * as path from 'path';
import { getAgentId } from './agent_config.js';
import {
  cleanLettaFromClaudeMd,
  createConversation,
  getMode,
} from './conversation_utils.js';

// Configuration
const LETTA_BASE_URL = process.env.LETTA_BASE_URL || 'https://api.letta.com';
const LETTA_API_BASE = `${LETTA_BASE_URL}/v1`;
const TEMP_STATE_DIR = '/tmp/letta-claude-sync';
const LOG_FILE = path.join(TEMP_STATE_DIR, 'session_start.log');

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name?: string;
}

interface ConversationEntry {
  conversationId: string;
  agentId: string;
}

// Support both old format (string) and new format (object) for backward compatibility
interface ConversationsMap {
  [sessionId: string]: string | ConversationEntry;
}

interface Conversation {
  id: string;
  agent_id: string;
  created_at?: string;
}

// Durable storage in .letta directory
// If LETTA_HOME is set, use that as the base instead of cwd
function getDurableStateDir(cwd: string): string {
  const base = process.env.LETTA_HOME || cwd;
  return path.join(base, '.letta', 'claude');
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

  const message = `<claude_code_session_start>
<project>${projectName}</project>
<path>${cwd}</path>
<session_id>${sessionId}</session_id>
<timestamp>${timestamp}</timestamp>

<context>
A new Claude Code session has begun. I'll be sending you updates as the session progresses.
You may update your memory blocks with any relevant context for this project.
</context>
</claude_code_session_start>`;

  log(`Sending session start message to conversation ${conversationId}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: message }],
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

  const mode = getMode();
  log(`Mode: ${mode}`);
  if (mode === 'off') {
    log('Mode is off, exiting');
    process.exit(0);
  }

  const apiKey = process.env.LETTA_API_KEY;

  if (!apiKey) {
    log('ERROR: LETTA_API_KEY not set');
    console.error('Error: LETTA_API_KEY must be set');
    process.exit(1);
  }

  try {
    // Get agent ID (from env, saved config, or auto-import)
    const agentId = await getAgentId(apiKey, log);
    // Read hook input
    log('Reading hook input from stdin...');
    const hookInput = await readHookInput();
    log(`Hook input: session_id=${hookInput.session_id}, cwd=${hookInput.cwd}`);

    // Check if conversation already exists for this session
    const conversationsMap = loadConversationsMap(hookInput.cwd);

    let conversationId: string;
    const cached = conversationsMap[hookInput.session_id];

    if (cached) {
      // Parse both old format (string) and new format (object)
      const entry = typeof cached === 'string'
        ? { conversationId: cached, agentId: null as string | null }
        : cached;

      if (entry.agentId && entry.agentId !== agentId) {
        // Agent ID changed - clear stale entry and create new conversation
        log(`Agent ID changed (${entry.agentId} -> ${agentId}), clearing stale conversation`);
        delete conversationsMap[hookInput.session_id];
        conversationId = await createConversation(apiKey, agentId, log);
        conversationsMap[hookInput.session_id] = { conversationId, agentId };
        saveConversationsMap(hookInput.cwd, conversationsMap);
      } else if (!entry.agentId) {
        // Old format without agentId - upgrade by recreating
        log(`Upgrading old format entry (no agentId stored), creating new conversation`);
        delete conversationsMap[hookInput.session_id];
        conversationId = await createConversation(apiKey, agentId, log);
        conversationsMap[hookInput.session_id] = { conversationId, agentId };
        saveConversationsMap(hookInput.cwd, conversationsMap);
      } else {
        // Valid entry with matching agentId - reuse
        conversationId = entry.conversationId;
        log(`Reusing existing conversation: ${conversationId}`);
      }
    } else {
      // No existing entry - create new conversation
      conversationId = await createConversation(apiKey, agentId, log);
      conversationsMap[hookInput.session_id] = { conversationId, agentId };
      saveConversationsMap(hookInput.cwd, conversationsMap);
    }

    // Save session state
    saveSessionState(hookInput.cwd, hookInput.session_id, conversationId);

    // Clean up any existing <letta> section from CLAUDE.md (legacy migration)
    log('Cleaning up any legacy CLAUDE.md content...');
    cleanLettaFromClaudeMd(hookInput.cwd);

    // Also clean the global ~/.claude/CLAUDE.md (may have bloat from pre-v1.3.0)
    const homeDir = process.env.HOME || os.homedir();
    if (homeDir !== hookInput.cwd) {
      log('Cleaning up global ~/.claude/CLAUDE.md...');
      cleanLettaFromClaudeMd(homeDir);
    }
    log('CLAUDE.md cleanup done');

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
