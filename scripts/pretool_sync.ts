#!/usr/bin/env tsx
/**
 * PreToolUse Memory Sync Script
 * 
 * Lightweight hook that checks for Letta agent updates mid-workflow.
 * Runs before each tool use to inject any new messages or memory changes.
 * 
 * Environment Variables:
 *   LETTA_API_KEY - API key for Letta authentication
 *   LETTA_DEBUG - Set to "1" to enable debug logging
 * 
 * Exit Codes:
 *   0 - Success (no output = no updates, JSON output = updates to inject)
 *   1 - Non-blocking error
 */

import * as fs from 'fs';
import * as readline from 'readline';
import { getAgentId } from './agent_config.js';
import {
  loadSyncState,
  saveSyncState,
  lookupConversation,
  SyncState,
  LETTA_API_BASE,
} from './conversation_utils.js';

const DEBUG = process.env.LETTA_DEBUG === '1';

function debug(...args: unknown[]): void {
  if (DEBUG) {
    console.error('[pretool debug]', ...args);
  }
}

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  tool_name?: string;
}

interface MemoryBlock {
  label: string;
  value: string;
}

interface Agent {
  id: string;
  name: string;
  blocks: MemoryBlock[];
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

    setTimeout(() => {
      rl.close();
    }, 100);
  });
}

/**
 * Fetch agent data from Letta API
 */
async function fetchAgent(apiKey: string, agentId: string): Promise<Agent> {
  const url = `${LETTA_API_BASE}/agents/${agentId}?include=agent.blocks`;
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Letta API error (${response.status})`);
  }

  return response.json();
}

/**
 * Fetch new assistant messages from the conversation
 */
async function fetchNewMessages(
  apiKey: string, 
  conversationId: string | null,
  lastSeenMessageId: string | null
): Promise<{ messages: MessageInfo[], lastMessageId: string | null }> {
  if (!conversationId) {
    return { messages: [], lastMessageId: null };
  }

  const url = `${LETTA_API_BASE}/conversations/${conversationId}/messages?limit=20`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    return { messages: [], lastMessageId: lastSeenMessageId };
  }

  const allMessages: LettaMessage[] = await response.json();
  const assistantMessages = allMessages.filter(msg => msg.message_type === 'assistant_message');

  // Find new messages (API returns newest first)
  let endIndex = assistantMessages.length;
  if (lastSeenMessageId) {
    const lastSeenIndex = assistantMessages.findIndex(msg => msg.id === lastSeenMessageId);
    if (lastSeenIndex !== -1) {
      endIndex = lastSeenIndex;
    }
  }

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

  const lastMessageId = assistantMessages.length > 0 
    ? assistantMessages[0].id 
    : lastSeenMessageId;

  return { messages: newMessages, lastMessageId };
}

/**
 * Detect changed memory blocks
 */
function detectChangedBlocks(
  currentBlocks: MemoryBlock[],
  lastBlockValues: { [label: string]: string } | null
): MemoryBlock[] {
  if (!lastBlockValues) {
    return [];
  }
  
  return currentBlocks.filter(block => {
    const previousValue = lastBlockValues[block.label];
    return previousValue === undefined || previousValue !== block.value;
  });
}

/**
 * Format output for PreToolUse additionalContext
 */
function formatOutput(
  agentName: string,
  messages: MessageInfo[],
  changedBlocks: MemoryBlock[],
  lastBlockValues: { [label: string]: string } | null
): string {
  const parts: string[] = [];

  // Format new messages
  if (messages.length > 0) {
    for (const msg of messages) {
      const timestamp = msg.date || 'unknown';
      parts.push(`<letta_message from="${agentName}" timestamp="${timestamp}">\n${msg.text}\n</letta_message>`);
    }
  }

  // Format changed blocks with diffs
  if (changedBlocks.length > 0) {
    const blockParts = changedBlocks.map(block => {
      const previousValue = lastBlockValues?.[block.label];
      
      if (previousValue === undefined) {
        return `<${block.label} status="new">\n${block.value}\n</${block.label}>`;
      }
      
      // Simple diff: show what changed
      const oldLines = new Set(previousValue.split('\n').map(l => l.trim()).filter(l => l));
      const newLines = block.value.split('\n').map(l => l.trim()).filter(l => l);
      
      const added = newLines.filter(line => !oldLines.has(line));
      const removed = Array.from(oldLines).filter(line => !newLines.includes(line));
      
      if (added.length === 0 && removed.length === 0) {
        return `<${block.label} status="modified">\n${block.value}\n</${block.label}>`;
      }
      
      const diffLines: string[] = [];
      for (const line of removed) {
        diffLines.push(`- ${line}`);
      }
      for (const line of added) {
        diffLines.push(`+ ${line}`);
      }
      
      return `<${block.label} status="modified">\n${diffLines.join('\n')}\n</${block.label}>`;
    });
    
    parts.push(`<letta_memory_update>\n${blockParts.join('\n')}\n</letta_memory_update>`);
  }

  return parts.join('\n\n');
}

/**
 * Main function
 */
async function main(): Promise<void> {
  const apiKey = process.env.LETTA_API_KEY;
  
  if (!apiKey) {
    debug('No LETTA_API_KEY set, skipping');
    process.exit(0);
  }

  try {
    const hookInput = await readHookInput();
    
    if (!hookInput?.session_id || !hookInput?.cwd) {
      debug('Missing session_id or cwd, skipping');
      process.exit(0);
    }

    debug(`PreToolUse for tool: ${hookInput.tool_name}`);

    // Load state
    const state = loadSyncState(hookInput.cwd, hookInput.session_id);
    
    // Need existing state to detect changes
    if (!state.lastBlockValues && !state.lastSeenMessageId) {
      debug('No previous state, skipping (UserPromptSubmit will handle first sync)');
      process.exit(0);
    }

    // Get agent ID
    const agentId = await getAgentId(apiKey);
    
    // Get conversation ID
    let conversationId = state.conversationId || null;
    if (!conversationId) {
      conversationId = lookupConversation(hookInput.cwd, hookInput.session_id);
    }

    // Fetch current state from Letta
    const [agent, messagesResult] = await Promise.all([
      fetchAgent(apiKey, agentId),
      fetchNewMessages(apiKey, conversationId, state.lastSeenMessageId || null),
    ]);

    const { messages: newMessages, lastMessageId } = messagesResult;
    const changedBlocks = detectChangedBlocks(agent.blocks || [], state.lastBlockValues || null);

    debug(`New messages: ${newMessages.length}, Changed blocks: ${changedBlocks.length}`);

    // If nothing changed, exit silently
    if (newMessages.length === 0 && changedBlocks.length === 0) {
      debug('No updates, exiting silently');
      process.exit(0);
    }

    // Format and output
    const additionalContext = formatOutput(
      agent.name || 'Subconscious',
      newMessages,
      changedBlocks,
      state.lastBlockValues || null
    );

    // Update state
    if (lastMessageId) {
      state.lastSeenMessageId = lastMessageId;
    }
    if (agent.blocks) {
      state.lastBlockValues = {};
      for (const block of agent.blocks) {
        state.lastBlockValues[block.label] = block.value;
      }
    }
    saveSyncState(hookInput.cwd, state);

    // Build the additional context with instruction to surface messages
    let contextWithInstruction = `<letta_update>\n${additionalContext}\n</letta_update>`;
    
    if (newMessages.length > 0) {
      const agentName = agent.name || 'Subconscious';
      contextWithInstruction += `\n\n<instruction>Your Subconscious (${agentName}) just sent a message mid-workflow. Briefly acknowledge what ${agentName} said in your next response - just a short note like "Sub notes: [key point]" so the user knows.</instruction>`;
    }

    // Output JSON for PreToolUse
    const output: Record<string, unknown> = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: contextWithInstruction,
      },
    };

    console.log(JSON.stringify(output));
    
  } catch (error) {
    debug(`Error: ${error}`);
    // Non-blocking - just exit silently
    process.exit(0);
  }
}

main();
