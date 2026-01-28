/**
 * Agent Configuration Utility
 * 
 * Resolves agent ID from (in order):
 * 1. LETTA_AGENT_ID environment variable
 * 2. Saved config file (~/.letta/claude-subconscious/config.json)
 * 3. Auto-import from bundled Subconscious.af
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LETTA_BASE_URL = process.env.LETTA_BASE_URL || 'https://api.letta.com';
const LETTA_API_BASE = `${LETTA_BASE_URL}/v1`;
const CONFIG_DIR = path.join(process.env.HOME || '~', '.letta', 'claude-subconscious');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_AGENT_FILE = path.join(__dirname, '..', 'Subconscious.af');

interface Config {
  agentId?: string;
  importedAt?: string;
}

/**
 * Regex for validating Letta agent ID format
 * Format: agent-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (UUID v4 with 'agent-' prefix)
 */
const AGENT_ID_REGEX = /^agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate agent ID format
 * 
 * @param agentId - The agent ID to validate
 * @returns true if valid, false otherwise
 */
export function isValidAgentId(agentId: string): boolean {
  return AGENT_ID_REGEX.test(agentId);
}

/**
 * Get a helpful error message for invalid agent ID format
 */
function getInvalidAgentIdMessage(agentId: string): string {
  const lines = [
    `Invalid LETTA_AGENT_ID format: "${agentId}"`,
    '',
    'The agent ID must be a UUID with the "agent-" prefix.',
    'Expected format: agent-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    'Example: agent-a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    '',
    'Common mistakes:',
    '  - Using the agent\'s friendly name (e.g., "Memo") instead of the UUID',
    '  - Missing the "agent-" prefix',
    '',
    'To find your agent ID:',
    '  1. Go to https://app.letta.com',
    '  2. Select your agent',
    '  3. Copy the ID from the URL or agent settings',
  ];
  return lines.join('\n');
}

/**
 * Read saved config
 */
function readConfig(): Config {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Save config
 */
function saveConfig(config: Config): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Get original agent name from .af file
 */
function getAgentNameFromFile(): string {
  try {
    const content = JSON.parse(fs.readFileSync(DEFAULT_AGENT_FILE, 'utf-8'));
    // .af files have agents array with name property
    if (content.agents && content.agents.length > 0 && content.agents[0].name) {
      return content.agents[0].name;
    }
  } catch {
    // Fall back to filename
  }
  return path.basename(DEFAULT_AGENT_FILE, '.af');
}

/**
 * Rename an agent
 */
async function renameAgent(apiKey: string, agentId: string, name: string): Promise<void> {
  const url = `${LETTA_API_BASE}/agents/${agentId}`;
  
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name }),
  });

  if (!response.ok) {
    // Non-fatal - agent still works with _copy name
    console.error(`Warning: Could not rename agent: ${response.status}`);
  }
}

/**
 * Import agent from .af file
 */
async function importDefaultAgent(apiKey: string): Promise<string> {
  const url = `${LETTA_API_BASE}/agents/import`;
  
  // Read the agent file
  const agentFileContent = fs.readFileSync(DEFAULT_AGENT_FILE);
  
  // Get original name for later rename
  const originalName = getAgentNameFromFile();
  
  // Create form data with the file
  const formData = new FormData();
  const blob = new Blob([agentFileContent], { type: 'application/json' });
  formData.append('file', blob, 'Subconscious.af');
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to import agent: ${response.status} ${errorText}`);
  }

  const result = await response.json();
  
  if (!result.agent_ids || result.agent_ids.length === 0) {
    throw new Error('Import succeeded but no agent ID returned');
  }
  
  const agentId = result.agent_ids[0];
  
  // Rename to original name (removes "_copy" suffix added by import)
  await renameAgent(apiKey, agentId, originalName);
  
  return agentId;
}

/**
 * Get or create agent ID
 * 
 * Returns the agent ID from env var, saved config, or imports the default agent
 */
export async function getAgentId(apiKey: string, log: (msg: string) => void = console.log): Promise<string> {
  // 1. Check environment variable
  const envAgentId = process.env.LETTA_AGENT_ID;
  if (envAgentId) {
    // Validate format before using
    if (!isValidAgentId(envAgentId)) {
      const errorMsg = getInvalidAgentIdMessage(envAgentId);
      log(`WARNING: ${errorMsg}`);
      throw new Error(errorMsg);
    }
    log(`Using agent ID from LETTA_AGENT_ID: ${envAgentId}`);
    return envAgentId;
  }
  
  // 2. Check saved config
  const config = readConfig();
  if (config.agentId) {
    // Validate saved config (in case it was manually edited or corrupted)
    if (!isValidAgentId(config.agentId)) {
      log(`WARNING: Saved agent ID has invalid format: ${config.agentId}`);
      log(`Ignoring invalid saved config and attempting to import default agent...`);
      // Fall through to import default agent
    } else {
      log(`Using saved agent ID: ${config.agentId}`);
      return config.agentId;
    }
  }
  
  // 3. Import default agent
  log('No agent configured - importing default Subconscious agent...');
  
  if (!fs.existsSync(DEFAULT_AGENT_FILE)) {
    throw new Error(`Default agent file not found: ${DEFAULT_AGENT_FILE}`);
  }
  
  const agentId = await importDefaultAgent(apiKey);
  log(`Imported agent: ${agentId}`);
  
  // Save for future use
  saveConfig({
    agentId,
    importedAt: new Date().toISOString(),
  });
  log(`Saved agent ID to ${CONFIG_FILE}`);
  
  return agentId;
}

/**
 * Check if we need to import (for quick checks without async)
 */
export function needsImport(): boolean {
  if (process.env.LETTA_AGENT_ID) return false;
  const config = readConfig();
  return !config.agentId;
}

/**
 * Get config file path (for logging/debugging)
 */
export function getConfigPath(): string {
  return CONFIG_FILE;
}
