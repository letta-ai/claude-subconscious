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
 * 
 * Exit Codes:
 *   0 - Success
 *   1 - Non-blocking error (logged to stderr)
 *   2 - Blocking error (prevents prompt processing)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// Configuration
const LETTA_API_BASE = 'https://api.letta.com/v1';
const LETTA_APP_BASE = 'https://app.letta.com';
const CLAUDE_MD_PATH = '.claude/CLAUDE.md';
const LETTA_SECTION_START = '<letta>';
const LETTA_SECTION_END = '</letta>';
const LETTA_CONTEXT_START = '<letta_context>';
const LETTA_CONTEXT_END = '</letta_context>';
const LETTA_MEMORY_START = '<letta_memory_blocks>';
const LETTA_MEMORY_END = '</letta_memory_blocks>';

interface MemoryBlock {
  label: string;
  description: string;
  value: string;
}

interface Agent {
  id: string;
  name: string;
  description?: string;
  blocks: MemoryBlock[];
}

interface LettaMessage {
  id: string;
  message_type: string;
  content?: string;
  text?: string;
  date?: string;
}

interface LastMessageInfo {
  text: string;
  date: string | null;
}

interface HookInput {
  session_id: string;
  cwd: string;
}

interface SessionState {
  conversationId?: string;
  lastBlockValues?: { [label: string]: string };  // label -> value for change detection
}

// State directory helpers
function getDurableStateDir(cwd: string): string {
  return path.join(cwd, '.letta', 'claude');
}

function getSyncStateFile(cwd: string, sessionId: string): string {
  return path.join(getDurableStateDir(cwd), `session-${sessionId}.json`);
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

    // Timeout after 100ms if no input
    setTimeout(() => {
      rl.close();
    }, 100);
  });
}

/**
 * Get conversation ID from session state
 */
function getConversationId(cwd: string, sessionId: string): string | null {
  const stateFile = getSyncStateFile(cwd, sessionId);
  if (fs.existsSync(stateFile)) {
    try {
      const state: SessionState = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      return state.conversationId || null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Get last known block values from session state
 */
function getLastBlockValues(cwd: string, sessionId: string): { [label: string]: string } | null {
  const stateFile = getSyncStateFile(cwd, sessionId);
  if (fs.existsSync(stateFile)) {
    try {
      const state: SessionState = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      return state.lastBlockValues || null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Save current block values to session state for change detection
 */
function saveBlockValues(cwd: string, sessionId: string, blocks: MemoryBlock[]): void {
  const stateFile = getSyncStateFile(cwd, sessionId);
  let state: SessionState = {};
  
  // Load existing state
  if (fs.existsSync(stateFile)) {
    try {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    } catch {
      // Start fresh if parse fails
    }
  }
  
  // Update block values
  state.lastBlockValues = {};
  for (const block of blocks) {
    state.lastBlockValues[block.label] = block.value;
  }
  
  // Ensure directory exists
  const dir = getDurableStateDir(cwd);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');
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
    const errorText = await response.text();
    throw new Error(`Letta API error (${response.status}): ${errorText}`);
  }

  return response.json();
}

/**
 * Fetch the last assistant message from the agent's conversation history
 */
async function fetchLastAssistantMessage(apiKey: string, agentId: string): Promise<LastMessageInfo | null> {
  const url = `${LETTA_API_BASE}/agents/${agentId}/messages?limit=10`;
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    // Don't fail if we can't fetch messages, just return null
    return null;
  }

  const messages: LettaMessage[] = await response.json();
  
  // Find the last assistant_message (search from end)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.message_type === 'assistant_message') {
      // Extract text content
      const text = msg.content || msg.text;
      if (text && typeof text === 'string') {
        return {
          text,
          date: msg.date || null,
        };
      }
    }
  }
  
  return null;
}

/**
 * Format the context section with agent info
 */
function formatContextSection(agent: Agent, conversationId: string | null): string {
  const agentUrl = `${LETTA_APP_BASE}/agents/${agent.id}`;
  const agentName = agent.name || 'Unnamed Agent';
  const agentDesc = agent.description || 'No description provided';
  const conversationLine = conversationId 
    ? `Conversation: ${LETTA_APP_BASE}/conversations/${conversationId}`
    : '';
  
  return `${LETTA_CONTEXT_START}
**Subconscious Layer (Letta Agent)**

Agent: ${agentName}
Description: ${agentDesc}
View: ${agentUrl}${conversationLine ? '\n' + conversationLine : ''}

This agent maintains persistent memory across your sessions. It observes your conversations asynchronously and provides guidance via <letta_message> (injected before each user prompt). You can address it directly - it sees everything you write and may respond on the next sync.

**First message instruction:** On your first response in a new session, briefly notify the user that this session is being observed by "${agentName}" and they can supervise it at: ${agentUrl}

Memory blocks below are the agent's long-term storage. Reference as needed.
${LETTA_CONTEXT_END}`;
}

/**
 * Format memory blocks as XML
 */
function formatMemoryBlocksAsXml(agent: Agent, conversationId: string | null): string {
  const blocks = agent.blocks;
  
  // Format context section
  const contextSection = formatContextSection(agent, conversationId);
  
  if (!blocks || blocks.length === 0) {
    return `${LETTA_SECTION_START}
${contextSection}

${LETTA_MEMORY_START}
<!-- No memory blocks found -->
${LETTA_MEMORY_END}
${LETTA_SECTION_END}`;
  }

  const formattedBlocks = blocks.map(block => {
    // Escape XML special characters in description and content
    const escapedDescription = escapeXmlAttribute(block.description || '');
    const escapedContent = escapeXmlContent(block.value || '');

    return `<${block.label} description="${escapedDescription}">\n${escapedContent}\n</${block.label}>`;
  }).join('\n');

  return `${LETTA_SECTION_START}
${contextSection}

${LETTA_MEMORY_START}
${formattedBlocks}
${LETTA_MEMORY_END}
${LETTA_SECTION_END}`;
}

/**
 * Format the last assistant message for stdout injection
 */
function formatMessageForStdout(agent: Agent, messageInfo: LastMessageInfo | null): string {
  const agentName = agent.name || 'Letta Agent';
  
  if (!messageInfo) {
    return `<!-- No letta message -->`;
  }
  
  const timestamp = messageInfo.date || 'unknown';
  return `<letta_message from="${agentName}" timestamp="${timestamp}">
${messageInfo.text}
</letta_message>`;
}

/**
 * Escape special characters for XML attributes
 */
function escapeXmlAttribute(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, ' '); // Replace newlines with spaces in attributes
}

/**
 * Escape special characters for XML element content
 * Only escapes &, <, > (quotes are fine in content)
 */
function escapeXmlContent(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Update CLAUDE.md with the new Letta memory section (message is now output to stdout)
 */
function updateClaudeMd(projectDir: string, lettaContent: string): void {
  const claudeMdPath = path.join(projectDir, CLAUDE_MD_PATH);
  
  let existingContent = '';
  
  // Check if file exists
  if (fs.existsSync(claudeMdPath)) {
    existingContent = fs.readFileSync(claudeMdPath, 'utf-8');
  } else {
    // Create directory if needed
    const claudeDir = path.dirname(claudeMdPath);
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }
    // Create default template
    existingContent = `# Project Context

<!-- Letta agent memory is automatically synced below -->
`;
  }

  // Replace or append the <letta> section
  // Use pattern that matches tag at start of line to avoid matching text inside content
  const lettaPattern = `^${escapeRegex(LETTA_SECTION_START)}[\\s\\S]*?^${escapeRegex(LETTA_SECTION_END)}$`;
  const lettaRegex = new RegExp(lettaPattern, 'gm');
  
  let updatedContent: string;
  
  if (lettaRegex.test(existingContent)) {
    // Reset regex after test() consumed position
    lettaRegex.lastIndex = 0;
    // Replace existing section
    updatedContent = existingContent.replace(lettaRegex, lettaContent);
  } else {
    // Append to end of file
    updatedContent = existingContent.trimEnd() + '\n\n' + lettaContent + '\n';
  }

  // Clean up any orphaned <letta_message> sections (now delivered via stdout)
  const messagePattern = /^<letta_message>[\s\S]*?^<\/letta_message>\n*/gm;
  updatedContent = updatedContent.replace(messagePattern, '');
  
  // Clean up any trailing whitespace/newlines
  updatedContent = updatedContent.trimEnd() + '\n';

  fs.writeFileSync(claudeMdPath, updatedContent, 'utf-8');
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Main function
 */
async function main(): Promise<void> {
  // Get environment variables
  const apiKey = process.env.LETTA_API_KEY;
  const agentId = process.env.LETTA_AGENT_ID;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Validate required environment variables
  if (!apiKey) {
    console.error('Error: LETTA_API_KEY environment variable is not set');
    process.exit(1);
  }

  if (!agentId) {
    console.error('Error: LETTA_AGENT_ID environment variable is not set');
    process.exit(1);
  }

  try {
    // Read hook input to get session ID for conversation lookup
    const hookInput = await readHookInput();
    const cwd = hookInput?.cwd || projectDir;
    const sessionId = hookInput?.session_id;
    
    // Get conversation ID and last block values from session state
    let conversationId: string | null = null;
    let lastBlockValues: { [label: string]: string } | null = null;
    if (sessionId) {
      conversationId = getConversationId(cwd, sessionId);
      lastBlockValues = getLastBlockValues(cwd, sessionId);
    }
    
    // Fetch agent data and last message in parallel
    const [agent, lastMessage] = await Promise.all([
      fetchAgent(apiKey, agentId),
      fetchLastAssistantMessage(apiKey, agentId),
    ]);
    
    // Detect which blocks have changed since last sync
    const changedBlocks = detectChangedBlocks(agent.blocks || [], lastBlockValues);
    
    // Format memory blocks as XML (includes context section)
    const lettaContent = formatMemoryBlocksAsXml(agent, conversationId);
    
    // Update CLAUDE.md with full memory blocks
    updateClaudeMd(cwd, lettaContent);
    
    // Save current block values for next sync's change detection
    if (sessionId) {
      saveBlockValues(cwd, sessionId, agent.blocks || []);
    }
    
    // Output to stdout - this gets injected before the user's prompt
    // (UserPromptSubmit hooks add stdout to context)
    const outputs: string[] = [];
    
    // Add changed blocks if any
    const changedBlocksOutput = formatChangedBlocksForStdout(changedBlocks, lastBlockValues);
    if (changedBlocksOutput) {
      outputs.push(changedBlocksOutput);
    }
    
    // Add last message
    const messageOutput = formatMessageForStdout(agent, lastMessage);
    outputs.push(messageOutput);
    
    console.log(outputs.join('\n\n'));
    
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
