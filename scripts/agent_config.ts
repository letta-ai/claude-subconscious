/**
 * Agent Configuration Utility
 * 
 * Resolves agent ID from (in order):
 * 1. LETTA_AGENT_ID environment variable
 * 2. Saved config file (~/.letta/claude-subconscious/config.json)
 * 3. Auto-import from bundled Subconscious.af
 * 
 * Model configuration:
 * - After agent creation, checks if the agent's model is available
 * - If not available, auto-selects from available models with preference order
 * - LETTA_MODEL environment variable can override (if available on server)
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

// Preferred models in order of preference for auto-selection
// Tilted towards quality - Subconscious needs good instruction following and tool use
const PREFERRED_MODELS = [
  'anthropic/claude-sonnet-4-5', // Best for agents per Anthropic
  'openai/gpt-4.1-mini',         // Good balance, 1M context, cheap
  'anthropic/claude-haiku-4-5',  // Fast Claude option
  'openai/gpt-5.2',              // Flagship fallback
  'google_ai/gemini-3-flash',    // Google's balanced option
  'google_ai/gemini-2.5-flash',  // Fallback
];

interface Config {
  agentId?: string;
  importedAt?: string;
  model?: string; // Track which model was configured
}

interface LettaModel {
  model: string;
  name: string;
  provider_type: string;
  handle?: string;
  display_name?: string;
}

interface LlmConfig {
  model?: string;
  handle?: string;
  provider_name?: string;
  model_endpoint_type?: string;
  model_endpoint?: string;
  provider_category?: string;
  context_window?: number;
  max_tokens?: number;
  temperature?: number;
  enable_reasoner?: boolean;
  max_reasoning_tokens?: number;
  [key: string]: unknown;
}

interface AgentDetails {
  id: string;
  name: string;
  llm_config?: LlmConfig;
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
 * List available models from Letta server
 */
async function listAvailableModels(apiKey: string): Promise<LettaModel[]> {
  const url = `${LETTA_API_BASE}/models/`;
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to list models: ${response.status}`);
  }

  return response.json();
}

/**
 * Get agent details including current model configuration
 */
async function getAgentDetails(apiKey: string, agentId: string): Promise<AgentDetails> {
  const url = `${LETTA_API_BASE}/agents/${agentId}`;
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get agent details: ${response.status}`);
  }

  return response.json();
}

/**
 * Get model handle from agent details
 * The handle format is "provider/model" (e.g., "openai/gpt-4o-mini")
 */
function getAgentModelHandle(agent: AgentDetails): string | null {
  const llmConfig = agent.llm_config;
  if (!llmConfig) return null;
  
  // Try handle first (newer format)
  if (llmConfig.handle) return llmConfig.handle;
  
  // Fall back to constructing from provider and model
  if (llmConfig.provider_name && llmConfig.model) {
    return `${llmConfig.provider_name}/${llmConfig.model}`;
  }
  
  return llmConfig.model || null;
}

/**
 * Check if a model is available on the server
 */
function isModelAvailable(models: LettaModel[], modelHandle: string): boolean {
  return findModel(models, modelHandle) !== null;
}

/**
 * Find a model in the available models list by handle.
 * Returns the matching LettaModel or null.
 */
export function findModel(models: LettaModel[], modelHandle: string): LettaModel | null {
  const normalizedHandle = modelHandle.toLowerCase();

  return models.find(m => {
    const handle = m.handle?.toLowerCase() || `${m.provider_type}/${m.model}`.toLowerCase();
    return handle === normalizedHandle ||
           m.model?.toLowerCase() === normalizedHandle ||
           `${m.provider_type}/${m.name}`.toLowerCase() === normalizedHandle;
  }) || null;
}

/**
 * Select best available model from preferences
 */
function selectBestModel(models: LettaModel[], preferences: string[]): string | null {
  // First, try preferred models in order
  for (const preferred of preferences) {
    if (isModelAvailable(models, preferred)) {
      return preferred;
    }
  }
  
  // Fall back to first available model
  if (models.length > 0) {
    const first = models[0];
    return first.handle || `${first.provider_type}/${first.model}`;
  }
  
  return null;
}

/**
 * Ensure agent's model is available on the server
 * If not, auto-select from available models and update the agent
 * 
 * @returns The model handle that was configured (or null if no change needed)
 */
async function ensureModelAvailable(
  apiKey: string,
  agentId: string,
  log: (msg: string) => void = console.log
): Promise<string | null> {
  try {
    // Get available models and agent details in parallel
    const [models, agent] = await Promise.all([
      listAvailableModels(apiKey),
      getAgentDetails(apiKey, agentId),
    ]);
    
    const currentModel = getAgentModelHandle(agent);
    log(`Agent's current model: ${currentModel || 'unknown'}`);
    log(`Available models: ${models.length} found`);
    
    // Check if LETTA_MODEL env var is set
    const envModel = process.env.LETTA_MODEL;
    if (envModel) {
      if (isModelAvailable(models, envModel)) {
        if (currentModel !== envModel) {
          log(`Using LETTA_MODEL override: ${envModel}`);
          await updateAgentModel(apiKey, agentId, envModel, models, agent.llm_config, log);
          return envModel;
        }
        // Model matches, but check if context_window needs updating
        const envCW = process.env.LETTA_CONTEXT_WINDOW;
        if (envCW && agent.llm_config?.context_window !== parseInt(envCW, 10)) {
          log(`Updating context_window to ${envCW} (was ${agent.llm_config?.context_window})`);
          await updateAgentModel(apiKey, agentId, envModel, models, agent.llm_config, log);
          return envModel;
        }
        return null; // Already using desired model and context_window
      } else {
        log(`Warning: LETTA_MODEL="${envModel}" is not available on this server`);
        log(`Available models: ${models.map(m => m.handle || `${m.provider_type}/${m.model}`).slice(0, 10).join(', ')}${models.length > 10 ? '...' : ''}`);
      }
    }

    // Check if current model is available
    if (currentModel && isModelAvailable(models, currentModel)) {
      log(`Agent's model "${currentModel}" is available`);
      return null; // No change needed
    }

    // Model not available - need to select alternative
    log(`Agent's model "${currentModel}" is NOT available on this server`);

    const selectedModel = selectBestModel(models, PREFERRED_MODELS);
    if (!selectedModel) {
      throw new Error('No models available on this server. Please configure your Letta server with at least one LLM provider.');
    }

    log(`Auto-selecting model: ${selectedModel}`);
    console.log(`\n⚠️  Model Update Required`);
    console.log(`   The Subconscious agent's default model (${currentModel}) is not available.`);
    console.log(`   Auto-selecting: ${selectedModel}`);
    console.log(`   To use a different model, set LETTA_MODEL environment variable.\n`);

    await updateAgentModel(apiKey, agentId, selectedModel, models, agent.llm_config, log);
    return selectedModel;
    
  } catch (error) {
    // Log but don't fail - the agent might still work
    log(`Warning: Could not verify model availability: ${error}`);
    return null;
  }
}

/**
 * Build llm_config for a model handle using metadata from the available models
 * list and the agent's current llm_config as a base.
 *
 * This preserves existing settings (context_window, temperature, etc.) while
 * overriding model-identity fields. If LETTA_CONTEXT_WINDOW is set, it takes
 * precedence over the current value.
 */
export function buildLlmConfig(
  modelHandle: string,
  models: LettaModel[],
  currentConfig: LlmConfig | undefined,
): LlmConfig {
  const slashIdx = modelHandle.indexOf('/');
  const providerName = slashIdx > 0 ? modelHandle.substring(0, slashIdx) : undefined;
  const modelName = slashIdx > 0 ? modelHandle.substring(slashIdx + 1) : modelHandle;

  const modelInfo = findModel(models, modelHandle);

  // Spread current config to preserve settings, then override model fields
  const config: LlmConfig = {
    ...(currentConfig || {}),
    model: modelName,
    handle: modelHandle,
    provider_name: providerName || modelInfo?.provider_type || currentConfig?.provider_name,
    model_endpoint_type: modelInfo?.provider_type || currentConfig?.model_endpoint_type,
  };

  // LETTA_CONTEXT_WINDOW env var overrides the current value
  const envContextWindow = process.env.LETTA_CONTEXT_WINDOW;
  if (envContextWindow) {
    const parsed = parseInt(envContextWindow, 10);
    if (!isNaN(parsed) && parsed > 0) {
      config.context_window = parsed;
    }
  }

  return config;
}

/**
 * Update agent's model configuration via the llm_config PATCH.
 *
 * Uses `{ llm_config: {...} }` instead of `{ model: "..." }` because the
 * top-level model PATCH resets context_window to a server-side default.
 * Sending the full llm_config preserves context_window and other settings.
 */
async function updateAgentModel(
  apiKey: string,
  agentId: string,
  modelHandle: string,
  models: LettaModel[],
  currentConfig: LlmConfig | undefined,
  log: (msg: string) => void = console.log
): Promise<void> {
  const url = `${LETTA_API_BASE}/agents/${agentId}`;

  log(`Updating agent model to: ${modelHandle}`);

  const llmConfig = buildLlmConfig(modelHandle, models, currentConfig);

  if (llmConfig.context_window && llmConfig.context_window !== currentConfig?.context_window) {
    log(`Including context_window: ${llmConfig.context_window}`);
  }

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ llm_config: llmConfig }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to update agent model: ${response.status} ${errorText}`);
  }

  log(`Agent model updated to: ${modelHandle}`);
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
 * Returns the agent ID from env var, saved config, or imports the default agent.
 * After getting the agent, verifies the model is available and auto-selects if not.
 */
export async function getAgentId(apiKey: string, log: (msg: string) => void = console.log): Promise<string> {
  let agentId: string;
  let config = readConfig();
  
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
    agentId = envAgentId;
  }
  // 2. Check saved config
  else if (config.agentId) {
    // Validate saved config (in case it was manually edited or corrupted)
    if (!isValidAgentId(config.agentId)) {
      log(`WARNING: Saved agent ID has invalid format: ${config.agentId}`);
      log(`Ignoring invalid saved config and attempting to import default agent...`);
      // Fall through to import default agent
      agentId = await importAndSaveAgent(apiKey, log);
      config = readConfig(); // Reload config after import
    } else {
      log(`Using saved agent ID: ${config.agentId}`);
      agentId = config.agentId;
    }
  }
  // 3. Import default agent
  else {
    agentId = await importAndSaveAgent(apiKey, log);
    config = readConfig(); // Reload config after import
  }
  
  // 4. Ensure model is available (auto-select if not)
  try {
    const configuredModel = await ensureModelAvailable(apiKey, agentId, log);
    if (configuredModel && config.model !== configuredModel) {
      // Update saved config with the model that was configured
      saveConfig({
        ...config,
        model: configuredModel,
      });
    }
  } catch (error) {
    log(`Warning: Could not verify model availability: ${error}`);
  }
  
  return agentId;
}

/**
 * Import default agent and save to config
 */
async function importAndSaveAgent(apiKey: string, log: (msg: string) => void): Promise<string> {
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
