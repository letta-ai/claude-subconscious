/**
 * Shared conversation and state management utilities
 * Used by sync_letta_memory.ts, send_messages_to_letta.ts, and session_start.ts
 */

import * as fs from 'fs';
import * as path from 'path';

// Configuration
const LETTA_BASE_URL = process.env.LETTA_BASE_URL || 'https://api.letta.com';
export const LETTA_API_BASE = `${LETTA_BASE_URL}/v1`;
// Only show app URL for hosted service; self-hosted users get IDs directly
const IS_HOSTED = !process.env.LETTA_BASE_URL;
const LETTA_APP_BASE = 'https://app.letta.com';

// CLAUDE.md constants
export const CLAUDE_MD_PATH = '.claude/CLAUDE.md';
export const LETTA_SECTION_START = '<letta>';
export const LETTA_SECTION_END = '</letta>';
const LETTA_CONTEXT_START = '<letta_context>';
const LETTA_CONTEXT_END = '</letta_context>';
const LETTA_MEMORY_START = '<letta_memory_blocks>';
const LETTA_MEMORY_END = '</letta_memory_blocks>';

// Types
export interface SyncState {
  lastProcessedIndex: number;
  sessionId: string;
  conversationId?: string;
  lastBlockValues?: { [label: string]: string };
  lastSeenMessageId?: string;  // Track last message ID we've shown to avoid duplicates
}

export interface ConversationEntry {
  conversationId: string;
  agentId: string;
}

export interface ConversationsMap {
  [sessionId: string]: string | ConversationEntry;
}

export interface Conversation {
  id: string;
  agent_id: string;
  created_at?: string;
}

export type LogFn = (message: string) => void;

// Default no-op logger
const noopLog: LogFn = () => {};

/**
 * Get durable state directory path
 */
export function getDurableStateDir(cwd: string): string {
  return path.join(cwd, '.letta', 'claude');
}

/**
 * Get conversations map file path
 */
export function getConversationsFile(cwd: string): string {
  return path.join(getDurableStateDir(cwd), 'conversations.json');
}

/**
 * Get sync state file path for a session
 */
export function getSyncStateFile(cwd: string, sessionId: string): string {
  return path.join(getDurableStateDir(cwd), `session-${sessionId}.json`);
}

/**
 * Ensure durable state directory exists
 */
export function ensureDurableStateDir(cwd: string): void {
  const dir = getDurableStateDir(cwd);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Load sync state for a session
 */
export function loadSyncState(cwd: string, sessionId: string, log: LogFn = noopLog): SyncState {
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
 * Save sync state for a session
 */
export function saveSyncState(cwd: string, state: SyncState, log: LogFn = noopLog): void {
  ensureDurableStateDir(cwd);
  const statePath = getSyncStateFile(cwd, state.sessionId);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
  log(`Saved state: lastProcessedIndex=${state.lastProcessedIndex}, conversationId=${state.conversationId}`);
}

/**
 * Load conversations mapping
 */
export function loadConversationsMap(cwd: string, log: LogFn = noopLog): ConversationsMap {
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
export function saveConversationsMap(cwd: string, map: ConversationsMap): void {
  ensureDurableStateDir(cwd);
  fs.writeFileSync(getConversationsFile(cwd), JSON.stringify(map, null, 2), 'utf-8');
}

/**
 * Create a new conversation for an agent
 */
export async function createConversation(apiKey: string, agentId: string, log: LogFn = noopLog): Promise<string> {
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
export async function getOrCreateConversation(
  apiKey: string,
  agentId: string,
  sessionId: string,
  cwd: string,
  state: SyncState,
  log: LogFn = noopLog
): Promise<string> {
  // Check if we already have a conversation ID in state
  if (state.conversationId) {
    log(`Using existing conversation from state: ${state.conversationId}`);
    return state.conversationId;
  }

  // Check the conversations map
  const conversationsMap = loadConversationsMap(cwd, log);
  const cached = conversationsMap[sessionId];

  if (cached) {
    // Parse both old format (string) and new format (object)
    const entry = typeof cached === 'string'
      ? { conversationId: cached, agentId: null as string | null }
      : cached;

    if (entry.agentId && entry.agentId !== agentId) {
      // Agent ID changed - clear stale entry and create new conversation
      log(`Agent ID changed (${entry.agentId} -> ${agentId}), clearing stale conversation`);
      delete conversationsMap[sessionId];
      const conversationId = await createConversation(apiKey, agentId, log);
      conversationsMap[sessionId] = { conversationId, agentId };
      saveConversationsMap(cwd, conversationsMap);
      state.conversationId = conversationId;
      return conversationId;
    } else if (!entry.agentId) {
      // Old format without agentId - upgrade by recreating
      log(`Upgrading old format entry (no agentId stored), creating new conversation`);
      delete conversationsMap[sessionId];
      const conversationId = await createConversation(apiKey, agentId, log);
      conversationsMap[sessionId] = { conversationId, agentId };
      saveConversationsMap(cwd, conversationsMap);
      state.conversationId = conversationId;
      return conversationId;
    } else {
      // Valid entry with matching agentId - reuse
      log(`Found conversation in map: ${entry.conversationId}`);
      state.conversationId = entry.conversationId;
      return entry.conversationId;
    }
  }

  // No existing entry - create a new conversation
  const conversationId = await createConversation(apiKey, agentId, log);

  // Save to map and state
  conversationsMap[sessionId] = { conversationId, agentId };
  saveConversationsMap(cwd, conversationsMap);
  state.conversationId = conversationId;

  return conversationId;
}

/**
 * Look up an existing conversation from conversations.json without creating a new one
 */
export function lookupConversation(cwd: string, sessionId: string): string | null {
  const conversationsFile = getConversationsFile(cwd);

  if (!fs.existsSync(conversationsFile)) {
    return null;
  }

  try {
    const content = fs.readFileSync(conversationsFile, 'utf-8');
    const conversationsMap: ConversationsMap = JSON.parse(content);
    const cached = conversationsMap[sessionId];

    if (!cached) {
      return null;
    }

    // Handle both legacy (string) and current (object) formats
    return typeof cached === 'string' ? cached : cached.conversationId;
  } catch {
    return null;
  }
}

/**
 * Send a message to a Letta conversation (fire-and-forget style)
 * Returns the response for the caller to handle
 */
export async function sendMessageToConversation(
  apiKey: string,
  conversationId: string,
  role: string,
  text: string,
  log: LogFn = noopLog
): Promise<Response> {
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

  log(`Response status: ${response.status}`);
  return response;
}

// ============================================
// Agent and Memory Block Types
// ============================================

export interface MemoryBlock {
  label: string;
  description: string;
  value: string;
}

export interface Agent {
  id: string;
  name: string;
  description?: string;
  blocks: MemoryBlock[];
}

// ============================================
// Agent Fetching
// ============================================

/**
 * Fetch agent data from Letta API
 */
export async function fetchAgent(apiKey: string, agentId: string): Promise<Agent> {
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

// ============================================
// XML Escaping Utilities
// ============================================

/**
 * Escape special characters for XML attributes
 */
export function escapeXmlAttribute(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, ' ');
}

/**
 * Escape special characters for XML element content
 */
export function escapeXmlContent(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escape special regex characters
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================
// CLAUDE.md Formatting and Writing
// ============================================

/**
 * Format the context section with agent info
 */
function formatContextSection(agent: Agent, conversationId: string | null): string {
  const agentName = agent.name || 'Unnamed Agent';
  const agentDesc = agent.description || 'No description provided';

  // For hosted service, show clickable URL; for self-hosted, show IDs
  let locationInfo: string;
  let supervisionInfo: string;
  if (IS_HOSTED) {
    const conversationUrl = conversationId
      ? `${LETTA_APP_BASE}/agents/${agent.id}?conversation=${conversationId}`
      : `${LETTA_APP_BASE}/agents/${agent.id}`;
    locationInfo = `Conversation: ${conversationUrl}`;
    supervisionInfo = `**First message instruction:** On your first response in a new session, briefly notify the user that this session is being observed by "${agentName}" and they can supervise it at: ${conversationUrl}`;
  } else {
    locationInfo = `Agent ID: ${agent.id}${conversationId ? `\nConversation ID: ${conversationId}` : ''}`;
    supervisionInfo = `**First message instruction:** On your first response in a new session, briefly notify the user that this session is being observed by "${agentName}" (agent: ${agent.id}${conversationId ? `, conversation: ${conversationId}` : ''}).`;
  }

  return `${LETTA_CONTEXT_START}
**Subconscious Layer (Letta Agent)**

Agent: ${agentName}
Description: ${agentDesc}
${locationInfo}

This agent maintains persistent memory across your sessions. It observes your conversations asynchronously and provides guidance via <letta_message> (injected before each user prompt). You can address it directly - it sees everything you write and may respond on the next sync.

${supervisionInfo}

Memory blocks below are the agent's long-term storage. Reference as needed.
${LETTA_CONTEXT_END}`;
}

/**
 * Format memory blocks as XML for CLAUDE.md
 */
export function formatMemoryBlocksAsXml(agent: Agent, conversationId: string | null): string {
  const blocks = agent.blocks;
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
 * Update CLAUDE.md with the new Letta memory section
 */
export function updateClaudeMd(projectDir: string, lettaContent: string): void {
  const claudeMdPath = path.join(projectDir, CLAUDE_MD_PATH);

  let existingContent = '';

  if (fs.existsSync(claudeMdPath)) {
    existingContent = fs.readFileSync(claudeMdPath, 'utf-8');
  } else {
    const claudeDir = path.dirname(claudeMdPath);
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }
    existingContent = `# Project Context

<!-- Letta agent memory is automatically synced below -->
`;
  }

  // Replace or append the <letta> section
  const lettaPattern = `^${escapeRegex(LETTA_SECTION_START)}[\\s\\S]*?^${escapeRegex(LETTA_SECTION_END)}$`;
  const lettaRegex = new RegExp(lettaPattern, 'gm');

  let updatedContent: string;

  if (lettaRegex.test(existingContent)) {
    lettaRegex.lastIndex = 0;
    updatedContent = existingContent.replace(lettaRegex, lettaContent);
  } else {
    updatedContent = existingContent.trimEnd() + '\n\n' + lettaContent + '\n';
  }

  // Clean up any orphaned <letta_message> sections
  const messagePattern = /^<letta_message>[\s\S]*?^<\/letta_message>\n*/gm;
  updatedContent = updatedContent.replace(messagePattern, '');

  updatedContent = updatedContent.trimEnd() + '\n';

  fs.writeFileSync(claudeMdPath, updatedContent, 'utf-8');
}
