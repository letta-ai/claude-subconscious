/**
 * Tests for agent_config.ts
 * 
 * Tests the isValidAgentId() validation function to ensure:
 * - Valid agent IDs are accepted
 * - Invalid agent IDs are rejected with helpful feedback
 */

import { describe, it, expect } from 'vitest';
import { isValidAgentId } from './agent_config.js';

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
