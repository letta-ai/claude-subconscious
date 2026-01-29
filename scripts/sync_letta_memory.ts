#!/usr/bin/env tsx
/**
 * Letta Memory Sync Script
 * 
 * Syncs Letta agent memory blocks to the project's CLAUDE.md file.
 * This script is designed to run as a Claude Code UserPromptSubmit hook.
 * 
 * Environment Variables:
 *   LETTA_API_KEY - API key for Letta authentication
 *   LETTA_AGENT_ID - Agent ID to fetch memory blocks from
 *   CLAUDE_PROJECT_DIR - Project directory (set by Claude Code)
 *   LETTA_DEBUG - Set to "1" to enable debug logging to stderr
 * 
 * Exit Codes:
 *   0 - Success
 *   1 - Non-blocking error (logged to stderr)
 *   2 - Blocking error (prevents prompt processing)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { getAgentId } from './agent_config.js';
import {
  loadSyncState,
  saveSyncState,
  getOrCreateConversation,
  getSyncStateFile,
  lookupConversation,
  SyncState,
  Agent,
  MemoryBlock,
  fetchAgent,
  escapeXmlContent,
  formatMemoryBlocksAsXml,
  updateClaudeMd,
  LETTA_API_BASE,
} from './conversation_utils.js';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Windows compatibility: npx needs to be npx.cmd on Windows
const NPX_CMD = process.platform === 'win32' ? 'npx.cmd' : 'npx';

// Configuration
const DEBUG = process.env.LETTA_DEBUG === '1';

function debug(...args: unknown[]): void {
  if (DEBUG) {
    console.error('[sync debug]', ...args);
  }
}

interface LettaMessage {
  id: string;
  message_type: string;
  content?: string;
  text?: string;
  date?: string;
}

interface MessageInfo {
  id: string;
  text: string;
  date: string | null;
}

interface HookInput {
  session_id: string;
  cwd: string;
  prompt?: string;  // User's prompt text (available on UserPromptSubmit)
  transcript_path?: string;  // Path to transcript JSONL
}

// Temp state directory for logs
const TEMP_STATE_DIR = '/tmp/letta-claude-sync';

/**
 * Read hook input from stdin
 */
async function readHookInput(): Promise<HookInput | null> {
  return new Promise((resolve) => {
    let input = '';
    const rl = readline.createInterface({ input: process.stdin });
    
    rl.on('line', (line) => {
      input += line;
    });
    
    rl.on('close', () => {
      if (!input.trim()) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(input));
      } catch {
        resolve(null);
      }
    });

    // Timeout after 100ms if no input
    setTimeout(() => {
      rl.close();
    }, 100);
  });
}

/**
 * Count lines in transcript file (for tracking lastProcessedIndex)
 */
function countTranscriptLines(transcriptPath: string): number {
  if (!fs.existsSync(transcriptPath)) {
    return 0;
  }
  const content = fs.readFileSync(transcriptPath, 'utf-8');
  return content.split('\n').filter(line => line.trim()).length;
}

/**
 * Detect which blocks have changed since last sync
 */
function detectChangedBlocks(
  currentBlocks: MemoryBlock[],
  lastBlockValues: { [label: string]: string } | null
): MemoryBlock[] {
  // First sync - no previous state, don't show all blocks as "changed"
  if (!lastBlockValues) {
    return [];
  }
  
  return currentBlocks.filter(block => {
    const previousValue = lastBlockValues[block.label];
    // Changed if: new block (not in previous) or value differs
    return previousValue === undefined || previousValue !== block.value;
  });
}

/**
 * Compute a simple line-based diff between two strings
 */
function computeDiff(oldValue: string, newValue: string): { added: string[], removed: string[] } {
  const oldLines = oldValue.split('\n').map(l => l.trim()).filter(l => l);
  const newLines = newValue.split('\n').map(l => l.trim()).filter(l => l);
  
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  
  const added = newLines.filter(line => !oldSet.has(line));
  const removed = oldLines.filter(line => !newSet.has(line));
  
  return { added, removed };
}

/**
 * Format changed blocks for stdout injection with diffs
 */
function formatChangedBlocksForStdout(
  changedBlocks: MemoryBlock[],
  lastBlockValues: { [label: string]: string } | null
): string {
  if (changedBlocks.length === 0) {
    return '';
  }
  
  const formatted = changedBlocks.map(block => {
    const previousValue = lastBlockValues?.[block.label];
    
    // New block - show full content
    if (previousValue === undefined) {
      const escapedContent = escapeXmlContent(block.value || '');
      return `<${block.label} status="new">\n${escapedContent}\n</${block.label}>`;
    }
    
    // Existing block - show diff
    const diff = computeDiff(previousValue, block.value || '');
    
    if (diff.added.length === 0 && diff.removed.length === 0) {
      // Whitespace-only change, show full content
      const escapedContent = escapeXmlContent(block.value || '');
      return `<${block.label} status="modified">\n${escapedContent}\n</${block.label}>`;
    }
    
    const diffLines: string[] = [];
    for (const line of diff.removed) {
      diffLines.push(`- ${escapeXmlContent(line)}`);
    }
    for (const line of diff.added) {
      diffLines.push(`+ ${escapeXmlContent(line)}`);
    }
    
    return `<${block.label} status="modified">\n${diffLines.join('\n')}\n</${block.label}>`;
  }).join('\n');
  
  return `<letta_memory_update>
<!-- Memory blocks updated since last prompt (showing diff) -->
${formatted}
</letta_memory_update>`;
}

/**
 * Fetch all assistant messages from the conversation history since last seen
 */
async function fetchAssistantMessages(
  apiKey: string, 
  conversationId: string | null,
  lastSeenMessageId: string | null
): Promise<{ messages: MessageInfo[], lastMessageId: string | null }> {
  if (!conversationId) {
    // No conversation yet, return empty
    return { messages: [], lastMessageId: null };
  }

  const url = `${LETTA_API_BASE}/conversations/${conversationId}/messages?limit=50`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    // Don't fail if we can't fetch messages, just return empty
    return { messages: [], lastMessageId: lastSeenMessageId };
  }

  const allMessages: LettaMessage[] = await response.json();
  debug(`Fetched ${allMessages.length} total messages from conversation`);

  // Filter to assistant messages only
  // NOTE: API returns messages newest-first
  const assistantMessages = allMessages.filter(msg => msg.message_type === 'assistant_message');
  debug(`Found ${assistantMessages.length} assistant messages`);

  // Find the index of the last seen message
  // Since messages are newest-first, new messages are BEFORE lastSeenIndex (indices 0 to lastSeenIndex-1)
  let endIndex = assistantMessages.length; // Default: return all messages
  if (lastSeenMessageId) {
    const lastSeenIndex = assistantMessages.findIndex(msg => msg.id === lastSeenMessageId);
    debug(`lastSeenMessageId=${lastSeenMessageId}, lastSeenIndex=${lastSeenIndex}`);
    if (lastSeenIndex !== -1) {
      // Only return messages newer than the last seen one (before it in the array)
      endIndex = lastSeenIndex;
    }
  }
  debug(`endIndex=${endIndex}, will return messages from index 0 to ${endIndex - 1}`);

  // Get new messages (from 0 to endIndex, which are the newest messages)
  const newMessages: MessageInfo[] = [];
  for (let i = 0; i < endIndex; i++) {
    const msg = assistantMessages[i];
    const text = msg.content || msg.text;
    if (text && typeof text === 'string') {
      newMessages.push({
        id: msg.id,
        text,
        date: msg.date || null,
      });
    }
  }
  debug(`Returning ${newMessages.length} new messages`);

  // Get the last message ID for tracking (the NEWEST message, which is first in the array)
  const lastMessageId = assistantMessages.length > 0
    ? assistantMessages[0].id
    : lastSeenMessageId;
  debug(`Setting lastMessageId=${lastMessageId}`);

  return { messages: newMessages, lastMessageId };
}

/**
 * Format assistant messages for stdout injection
 */
function formatMessagesForStdout(agent: Agent, messages: MessageInfo[]): string {
  const agentName = agent.name || 'Letta Agent';
  
  if (messages.length === 0) {
    return `<!-- No new messages from ${agentName} -->`;
  }
  
  // Format each message
  const formattedMessages = messages.map((msg, index) => {
    const timestamp = msg.date || 'unknown';
    const msgNum = messages.length > 1 ? ` (${index + 1}/${messages.length})` : '';
    return `<letta_message from="${agentName}"${msgNum} timestamp="${timestamp}">
${msg.text}
</letta_message>`;
  });
  
  return formattedMessages.join('\n\n');
}

/**
 * Main function
 */
async function main(): Promise<void> {
  // Get environment variables
  const apiKey = process.env.LETTA_API_KEY;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Validate required environment variables
  if (!apiKey) {
    console.error('Error: LETTA_API_KEY environment variable is not set');
    process.exit(1);
  }

  try {
    // Get agent ID (from env, saved config, or auto-import)
    const agentId = await getAgentId(apiKey);
    // Read hook input to get session ID for conversation lookup
    const hookInput = await readHookInput();
    const cwd = hookInput?.cwd || projectDir;
    const sessionId = hookInput?.session_id;
    
    // Load state using shared utility
    let state: SyncState | null = null;
    if (sessionId) {
      state = loadSyncState(cwd, sessionId);
    }
    
    // Recover conversationId from conversations.json if state doesn't have it
    let conversationId = state?.conversationId || null;
    if (!conversationId && sessionId) {
      conversationId = lookupConversation(cwd, sessionId);
      // Update state so we don't have to look it up again
      if (conversationId && state) {
        state.conversationId = conversationId;
      }
    }
    const lastBlockValues = state?.lastBlockValues || null;
    const lastSeenMessageId = state?.lastSeenMessageId || null;
    
    // Fetch agent data and messages in parallel
    const [agent, messagesResult] = await Promise.all([
      fetchAgent(apiKey, agentId),
      fetchAssistantMessages(apiKey, conversationId, lastSeenMessageId),
    ]);
    
    const { messages: newMessages, lastMessageId } = messagesResult;
    
    // Detect which blocks have changed since last sync
    const changedBlocks = detectChangedBlocks(agent.blocks || [], lastBlockValues);
    
    // Format memory blocks as XML (includes context section)
    const lettaContent = formatMemoryBlocksAsXml(agent, conversationId);
    
    // Update CLAUDE.md with full memory blocks
    updateClaudeMd(cwd, lettaContent);
    
    // Update state with block values and last seen message ID
    if (state) {
      state.lastBlockValues = {};
      for (const block of agent.blocks || []) {
        state.lastBlockValues[block.label] = block.value;
      }
      // Track the last message we've seen
      if (lastMessageId) {
        state.lastSeenMessageId = lastMessageId;
      }
    }
    
    // Output to stdout - this gets injected before the user's prompt
    // (UserPromptSubmit hooks add stdout to context)
    const outputs: string[] = [];
    
    // Add changed blocks if any
    const changedBlocksOutput = formatChangedBlocksForStdout(changedBlocks, lastBlockValues);
    if (changedBlocksOutput) {
      outputs.push(changedBlocksOutput);
    }
    
    // Add all new messages from Sub
    const messageOutput = formatMessagesForStdout(agent, newMessages);
    outputs.push(messageOutput);
    
    // Add instruction to acknowledge messages if there are any
    if (newMessages.length > 0) {
      const agentName = agent.name || 'Subconscious';
      outputs.push(`<instruction>Your Subconscious (${agentName}) sent you a message above. Briefly acknowledge what ${agentName} said - just a short note like "Sub notes: [key point]" so the user knows.</instruction>`);
    }
    
    console.log(outputs.join('\n\n'));
    
    // Send user prompt to Letta early (gives Letta a head start while Claude processes)
    if (sessionId && hookInput?.prompt && state) {
      try {
        // Ensure we have a conversation
        const convId = await getOrCreateConversation(apiKey, agentId, sessionId, cwd, state);
        
        // Get current transcript length for index tracking
        const transcriptLength = hookInput.transcript_path 
          ? countTranscriptLines(hookInput.transcript_path)
          : 0;
        
        // Format the prompt message
        const promptMessage = `<claude_code_user_prompt>
<session_id>${sessionId}</session_id>
<prompt>${escapeXmlContent(hookInput.prompt)}</prompt>
<note>Early notification - Claude Code is processing this now. Full transcript with response will follow.</note>
</claude_code_user_prompt>`;

        // Write payload for background worker
        if (!fs.existsSync(TEMP_STATE_DIR)) {
          fs.mkdirSync(TEMP_STATE_DIR, { recursive: true });
        }
        const payloadFile = path.join(TEMP_STATE_DIR, `prompt-${sessionId}-${Date.now()}.json`);
        
        const payload = {
          apiKey,
          conversationId: convId,
          sessionId,
          message: promptMessage,
          stateFile: getSyncStateFile(cwd, sessionId),
          newLastProcessedIndex: transcriptLength > 0 ? transcriptLength - 1 : 0,
        };
        fs.writeFileSync(payloadFile, JSON.stringify(payload), 'utf-8');
        
        // Spawn background worker
        const workerScript = path.join(__dirname, 'send_worker.ts');
        const isWindows = process.platform === 'win32';
        const child = spawn(NPX_CMD, ['tsx', workerScript, payloadFile], {
          detached: true,
          stdio: 'ignore',
          cwd,
          env: process.env,
          // Windows requires shell: true for detached processes to work properly
          ...(isWindows && { shell: true, windowsHide: true }),
        });
        child.unref();
      } catch (promptError) {
        // Don't fail the sync if prompt sending fails - just log warning
        console.error(`Warning: Failed to send prompt to Letta: ${promptError}`);
      }
    }
    
    // Save state
    if (state && sessionId) {
      saveSyncState(cwd, state);
    }
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error syncing Letta memory: ${errorMessage}`);
    // Exit with code 1 for non-blocking error
    // Change to exit(2) if you want to block prompt processing on sync failures
    process.exit(1);
  }
}

// Run main function
main();
