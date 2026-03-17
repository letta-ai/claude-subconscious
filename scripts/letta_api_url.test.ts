import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildLettaApiUrl,
  getLettaApiBase,
  normalizeLettaBaseUrl,
} from './letta_api_url.js';

describe('letta_api_url', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('normalizes base URL by trimming trailing slash', () => {
    expect(normalizeLettaBaseUrl('https://example.com/')).toBe(
      'https://example.com',
    );
    expect(normalizeLettaBaseUrl('https://example.com///')).toBe(
      'https://example.com',
    );
  });

  it('builds /v1 base URL unless already present', () => {
    expect(getLettaApiBase('https://example.com')).toBe(
      'https://example.com/v1',
    );
    expect(getLettaApiBase('https://example.com/v1')).toBe(
      'https://example.com/v1',
    );
  });

  it('builds URLs with optional query params', () => {
    const url = buildLettaApiUrl('/agents/agent-123', {
      include: 'agent.blocks',
      limit: 20,
    });

    expect(url).toBe(
      'https://api.letta.com/v1/agents/agent-123?include=agent.blocks&limit=20',
    );
  });

  it('preserves trailing slash path for conversations create endpoint', () => {
    const url = buildLettaApiUrl('/conversations/', { agent_id: 'agent-123' });

    expect(url).toBe(
      'https://api.letta.com/v1/conversations/?agent_id=agent-123',
    );
  });
});