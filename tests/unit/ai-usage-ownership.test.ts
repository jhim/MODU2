import { describe, expect, it } from 'vitest';
import { MemoryLearningRepository } from '../../server/src/repositories/memory.js';
import { calculateAiUsage } from '../../server/src/services/ai-pricing.js';

describe('AI usage session ownership', () => {
  it('prevents usage created under one verified owner from being attributed to another', async () => {
    const repository = new MemoryLearningRepository();
    const sessionId = crypto.randomUUID();
    await repository.recordAiUsage({ sessionId, requestId: crypto.randomUUID(), operation: 'suggestions',
      ownerId: 'owner-a', usage: calculateAiUsage({ model: 'gpt-4o-mini', inputTokens: 10, outputTokens: 5, totalTokens: 15 }) });
    await expect(repository.recordAiUsage({ sessionId, requestId: crypto.randomUUID(), operation: 'flashcard_generation',
      ownerId: 'owner-b', usage: calculateAiUsage({ model: 'gpt-4o-mini', inputTokens: 10, outputTokens: 5, totalTokens: 15 }) }))
      .rejects.toThrow('another user');
  });
});
