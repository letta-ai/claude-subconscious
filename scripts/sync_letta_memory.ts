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
const LETTA_MESSAGE_START = '<letta_message>';
const LETTA_MESSAGE_END = '</letta_message>';

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
function formatContextSection(agent: Agent): string {
  const agentUrl = `${LETTA_APP_BASE}/agents/${agent.id}`;
  const agentName = agent.name || 'Unnamed Agent';
  const agentDesc = agent.description || 'No description provided';
  
  return `${LETTA_CONTEXT_START}
**Subconscious Layer (Letta Agent)**

Agent: ${agentName}
Description: ${agentDesc}
View: ${agentUrl}

This agent maintains persistent memory across your sessions. It observes your conversations asynchronously and provides guidance below in <letta_message>. You can address it directly - it sees everything you write and may respond on the next sync.

Memory blocks below are the agent's long-term storage. Reference as needed.
${LETTA_CONTEXT_END}`;
}

/**
 * Format memory blocks as XML
 */
function formatMemoryBlocksAsXml(agent: Agent): string {
  const blocks = agent.blocks;
  
  // Format context section
  const contextSection = formatContextSection(agent);
  
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
 * Format the last assistant message as XML
 */
function formatLastMessageAsXml(agent: Agent, messageInfo: LastMessageInfo | null): string {
  const agentName = agent.name || 'Unnamed Agent';
  
  if (!messageInfo) {
    return `${LETTA_MESSAGE_START}
<!-- No recent message from ${agentName} -->
${LETTA_MESSAGE_END}`;
  }
  
  const timestamp = messageInfo.date 
    ? `**Timestamp**: ${messageInfo.date}` 
    : '**Timestamp**: Unknown';
  
  return `${LETTA_MESSAGE_START}
<!--
  ASYNC MESSAGE FROM LETTA AGENT
  
  This is the most recent message from "${agentName}".
  
  NOTE: This message may not be current or directly relevant to your current task.
  The Letta agent processes Claude Code conversations asynchronously and may provide
  commentary, guidance, or context that was generated in response to earlier interactions.
  
  ${timestamp}
-->

${messageInfo.text}
${LETTA_MESSAGE_END}`;
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
 * Update CLAUDE.md with the new Letta section and message
 */
function updateClaudeMd(projectDir: string, lettaContent: string, messageContent: string): void {
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

  // Replace or append the <letta_message> section
  const messagePattern = `^${escapeRegex(LETTA_MESSAGE_START)}[\\s\\S]*?^${escapeRegex(LETTA_MESSAGE_END)}$`;
  const messageRegex = new RegExp(messagePattern, 'gm');
  
  if (messageRegex.test(updatedContent)) {
    // Reset regex after test() consumed position
    messageRegex.lastIndex = 0;
    // Replace existing section
    updatedContent = updatedContent.replace(messageRegex, messageContent);
  } else {
    // Append after letta section
    updatedContent = updatedContent.trimEnd() + '\n\n' + messageContent + '\n';
  }

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
    // Fetch agent data and last message in parallel
    const [agent, lastMessage] = await Promise.all([
      fetchAgent(apiKey, agentId),
      fetchLastAssistantMessage(apiKey, agentId),
    ]);
    
    // Format memory blocks as XML (includes context section)
    const lettaContent = formatMemoryBlocksAsXml(agent);
    
    // Format last message as XML (includes agent info and timestamp)
    const messageContent = formatLastMessageAsXml(agent, lastMessage);
    
    // Update CLAUDE.md
    updateClaudeMd(projectDir, lettaContent, messageContent);
    
    // Success - don't output anything for UserPromptSubmit hooks
    // (stdout would be added to context, which we don't want)
    
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
