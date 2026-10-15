import { describe, expect, it } from 'vitest';
import { calculateAiUsage } from '../../server/src/services/ai-pricing.js';

describe('OpenAI usage estimate', () => {
  it('uses cached and uncached input rates plus output rate from the actual model', () => {
    const usage = calculateAiUsage({ model: 'gpt-4o-mini-2024-07-18', inputTokens: 1000,
      outputTokens: 250, totalTokens: 1250, cachedInputTokens: 400 });
    const expectedUsd = ((600 * 0.15) + (400 * 0.075) + (250 * 0.60)) / 1_000_000;
    expect(usage).toMatchObject({ model: 'gpt-4o-mini-2024-07-18', inputTokens: 1000,
      outputTokens: 250, totalTokens: 1250, cachedInputTokens: 400,
      inputUsdPerMillion: 0.15, cachedInputUsdPerMillion: 0.075, outputUsdPerMillion: 0.60 });
    expect(usage.estimatedUsd).toBeCloseTo(expectedUsd, 12);
    expect(usage.estimatedKrw).toBeCloseTo(expectedUsd * usage.usdKrwRate, 12);
    expect(usage.pricingAsOf).toBe('2026-10-15');
    expect(usage.fxRateAsOf).toBe('2026-10-13');
  });

  it('keeps actual tokens while leaving costs blank for an unpriced model', () => {
    const usage = calculateAiUsage({ model: 'future-model', inputTokens: 24, outputTokens: 6, totalTokens: 30 });
    expect(usage).toMatchObject({ inputTokens: 24, outputTokens: 6, totalTokens: 30,
      estimatedUsd: null, estimatedKrw: null, inputUsdPerMillion: null, outputUsdPerMillion: null });
  });
});
