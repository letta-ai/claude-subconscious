/**
 * Tests for agent_config.ts
 *
 * Tests the isValidAgentId() validation function to ensure:
 * - Valid agent IDs are accepted
 * - Invalid agent IDs are rejected with helpful feedback
 *
 * Tests findModel() for model lookup in the available models list.
 * Tests buildLlmConfig() for correct llm_config construction.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { isValidAgentId, findModel, buildLlmConfig } from './agent_config.js';

describe('isValidAgentId', () => {
  describe('valid agent IDs', () => {
    it('should accept a properly formatted agent ID', () => {
      expect(isValidAgentId('agent-a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(true);
    });

    it('should accept agent IDs with uppercase hex characters', () => {
      expect(isValidAgentId('agent-A1B2C3D4-E5F6-7890-ABCD-EF1234567890')).toBe(true);
    });

    it('should accept agent IDs with mixed case hex characters', () => {
      expect(isValidAgentId('agent-a1B2c3D4-e5F6-7890-AbCd-eF1234567890')).toBe(true);
    });

    it('should accept real-world agent ID format', () => {
      expect(isValidAgentId('agent-eed2d657-289a-4842-b00f-d99dd9921ec7')).toBe(true);
    });
  });

  describe('invalid agent IDs - friendly names', () => {
    it('should reject a friendly name like "Memo"', () => {
      expect(isValidAgentId('Memo')).toBe(false);
    });

    it('should reject a friendly name with spaces', () => {
      expect(isValidAgentId('My Agent')).toBe(false);
    });

    it('should reject a friendly name like "Subconscious"', () => {
      expect(isValidAgentId('Subconscious')).toBe(false);
    });
  });

  describe('invalid agent IDs - missing prefix', () => {
    it('should reject UUID without "agent-" prefix', () => {
      expect(isValidAgentId('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(false);
    });

    it('should reject wrong prefix "agents-"', () => {
      expect(isValidAgentId('agents-a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(false);
    });

    it('should reject wrong prefix "user-"', () => {
      expect(isValidAgentId('user-a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(false);
    });
  });

  describe('invalid agent IDs - malformed UUID', () => {
    it('should reject truncated UUID', () => {
      expect(isValidAgentId('agent-a1b2c3d4-e5f6-7890-abcd')).toBe(false);
    });

    it('should reject UUID with extra characters', () => {
      expect(isValidAgentId('agent-a1b2c3d4-e5f6-7890-abcd-ef1234567890-extra')).toBe(false);
    });

    it('should reject UUID with wrong segment lengths', () => {
      expect(isValidAgentId('agent-a1b2c3d4e5f6-7890-abcd-ef1234567890')).toBe(false);
    });

    it('should reject UUID with invalid characters', () => {
      expect(isValidAgentId('agent-g1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(false);
    });
  });

  describe('invalid agent IDs - edge cases', () => {
    it('should reject empty string', () => {
      expect(isValidAgentId('')).toBe(false);
    });

    it('should reject just "agent-"', () => {
      expect(isValidAgentId('agent-')).toBe(false);
    });

    it('should reject whitespace', () => {
      expect(isValidAgentId('  ')).toBe(false);
    });

    it('should reject agent ID with leading/trailing whitespace', () => {
      expect(isValidAgentId(' agent-a1b2c3d4-e5f6-7890-abcd-ef1234567890 ')).toBe(false);
    });

    it('should reject agent ID with newlines', () => {
      expect(isValidAgentId('agent-a1b2c3d4-e5f6-7890-abcd-ef1234567890\n')).toBe(false);
    });
  });
});

// Sample models list used across findModel and buildLlmConfig tests
const SAMPLE_MODELS = [
  { model: 'claude-sonnet-4-5', name: 'claude-sonnet-4-5', provider_type: 'anthropic', handle: 'anthropic/claude-sonnet-4-5' },
  { model: 'gemini-3-pro-preview', name: 'gemini-3-pro-preview', provider_type: 'google_ai', handle: 'google_ai/gemini-3-pro-preview' },
  { model: 'gemini-3-pro-preview', name: 'gemini-3-pro-preview', provider_type: 'google_ai', handle: 'gem1/gemini-3-pro-preview' },
  { model: 'gpt-5.2', name: 'gpt-5.2', provider_type: 'openai', handle: 'openai/gpt-5.2' },
];

describe('findModel', () => {
  it('should find a model by exact handle match', () => {
    const result = findModel(SAMPLE_MODELS, 'anthropic/claude-sonnet-4-5');
    expect(result).not.toBeNull();
    expect(result!.handle).toBe('anthropic/claude-sonnet-4-5');
  });

  it('should find a model by BYOK provider handle', () => {
    const result = findModel(SAMPLE_MODELS, 'gem1/gemini-3-pro-preview');
    expect(result).not.toBeNull();
    expect(result!.handle).toBe('gem1/gemini-3-pro-preview');
  });

  it('should match case-insensitively', () => {
    const result = findModel(SAMPLE_MODELS, 'Anthropic/Claude-Sonnet-4-5');
    expect(result).not.toBeNull();
  });

  it('should match by bare model name', () => {
    const result = findModel(SAMPLE_MODELS, 'gpt-5.2');
    expect(result).not.toBeNull();
    expect(result!.provider_type).toBe('openai');
  });

  it('should return null for unknown model', () => {
    expect(findModel(SAMPLE_MODELS, 'unknown/model')).toBeNull();
  });

  it('should return null for empty models list', () => {
    expect(findModel([], 'anthropic/claude-sonnet-4-5')).toBeNull();
  });
});

describe('buildLlmConfig', () => {
  afterEach(() => {
    delete process.env.LETTA_CONTEXT_WINDOW;
  });

  it('should set model and handle from the model handle', () => {
    const config = buildLlmConfig('anthropic/claude-sonnet-4-5', SAMPLE_MODELS, undefined);
    expect(config.model).toBe('claude-sonnet-4-5');
    expect(config.handle).toBe('anthropic/claude-sonnet-4-5');
    expect(config.provider_name).toBe('anthropic');
  });

  it('should preserve current config settings', () => {
    const current = { model: 'old-model', context_window: 32000, temperature: 0.7 };
    const config = buildLlmConfig('openai/gpt-5.2', SAMPLE_MODELS, current);
    expect(config.model).toBe('gpt-5.2');
    expect(config.context_window).toBe(32000);
    expect(config.temperature).toBe(0.7);
  });

  it('should override context_window from LETTA_CONTEXT_WINDOW env var', () => {
    process.env.LETTA_CONTEXT_WINDOW = '1048576';
    const current = { model: 'old-model', context_window: 32000 };
    const config = buildLlmConfig('openai/gpt-5.2', SAMPLE_MODELS, current);
    expect(config.context_window).toBe(1048576);
  });

  it('should ignore invalid LETTA_CONTEXT_WINDOW values', () => {
    process.env.LETTA_CONTEXT_WINDOW = 'not-a-number';
    const current = { model: 'old-model', context_window: 32000 };
    const config = buildLlmConfig('openai/gpt-5.2', SAMPLE_MODELS, current);
    expect(config.context_window).toBe(32000);
  });

  it('should ignore negative LETTA_CONTEXT_WINDOW values', () => {
    process.env.LETTA_CONTEXT_WINDOW = '-100';
    const current = { model: 'old-model', context_window: 32000 };
    const config = buildLlmConfig('openai/gpt-5.2', SAMPLE_MODELS, current);
    expect(config.context_window).toBe(32000);
  });

  it('should resolve provider_type from the models list', () => {
    const config = buildLlmConfig('gem1/gemini-3-pro-preview', SAMPLE_MODELS, undefined);
    expect(config.provider_name).toBe('gem1');
    expect(config.model_endpoint_type).toBe('google_ai');
  });

  it('should work with no current config', () => {
    const config = buildLlmConfig('openai/gpt-5.2', SAMPLE_MODELS, undefined);
    expect(config.model).toBe('gpt-5.2');
    expect(config.handle).toBe('openai/gpt-5.2');
    expect(config.provider_name).toBe('openai');
  });
});
