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

const LETTA_API_BASE = 'https://api.letta.com/v1';
const CONFIG_DIR = path.join(process.env.HOME || '~', '.letta', 'claude-subconscious');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_AGENT_FILE = path.join(__dirname, '..', 'Subconscious.af');

interface Config {
  agentId?: string;
  importedAt?: string;
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
 * Import agent from .af file
 */
async function importDefaultAgent(apiKey: string): Promise<string> {
  const url = `${LETTA_API_BASE}/agents/import`;
  
  // Read the agent file
  const agentFileContent = fs.readFileSync(DEFAULT_AGENT_FILE);
  
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
  
  return result.agent_ids[0];
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
    log(`Using agent ID from LETTA_AGENT_ID: ${envAgentId}`);
    return envAgentId;
  }
  
  // 2. Check saved config
  const config = readConfig();
  if (config.agentId) {
    log(`Using saved agent ID: ${config.agentId}`);
    return config.agentId;
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
