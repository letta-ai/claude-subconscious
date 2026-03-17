import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

vi.stubGlobal('fetch', fetchMock);

describe('createConversation', () => {
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uses trailing-slash conversations endpoint with agent_id query', async () => {
    vi.stubEnv('LETTA_BASE_URL', 'https://letta.example.com');

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'conversation-123' }),
    });

    const { createConversation } = await import('./conversation_utils.js');
    const conversationId = await createConversation('test-key', 'agent-123');

    expect(conversationId).toBe('conversation-123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://letta.example.com/v1/conversations/?agent_id=agent-123',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
        }),
      }),
    );
  });
});