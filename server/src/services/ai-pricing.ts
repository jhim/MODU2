/**
 * Estimated standard OpenAI API pricing, per 1M tokens.
 * Prices checked against OpenAI's public pricing on 2026-10-15.
 * This application uses the standard global Chat Completions endpoint (not Batch).
 * Extend this table before enabling a model that is not listed; unknown models keep
 * their real token usage but intentionally have no estimated cost.
 */
export const OPENAI_PRICING_AS_OF = '2026-10-15';
export const USD_KRW_RATE = 1342.13;
export const USD_KRW_RATE_AS_OF = '2026-10-13';
export const USD_KRW_RATE_SOURCE = 'Federal Reserve H.10 / FRED DEXKOUS';

type ModelPrice = { input: number; cachedInput: number; output: number };
const MODEL_PRICES: Record<string, ModelPrice> = {
  'gpt-4o-mini': { input: 0.15, cachedInput: 0.075, output: 0.60 },
  'gpt-4.1-mini': { input: 0.40, cachedInput: 0.10, output: 1.60 },
};

export type AiUsageRecord = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  inputUsdPerMillion: number | null;
  cachedInputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  estimatedUsd: number | null;
  usdKrwRate: number;
  estimatedKrw: number | null;
  pricingAsOf: string;
  fxRateAsOf: string;
  fxRateSource: string;
};

export function calculateAiUsage(input: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number | null;
}): AiUsageRecord {
  const inputTokens = Math.max(0, Math.trunc(input.inputTokens));
  const outputTokens = Math.max(0, Math.trunc(input.outputTokens));
  const totalTokens = Math.max(0, Math.trunc(input.totalTokens));
  const cachedInputTokens = Math.min(inputTokens, Math.max(0, Math.trunc(input.cachedInputTokens ?? 0)));
  const matchedModel = Object.keys(MODEL_PRICES).find(model => input.model === model || input.model.startsWith(model + '-'));
  const price = matchedModel ? MODEL_PRICES[matchedModel] : undefined;
  const estimatedUsd = price
    ? ((inputTokens - cachedInputTokens) * price.input + cachedInputTokens * price.cachedInput + outputTokens * price.output) / 1_000_000
    : null;
  return {
    model: input.model,
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    inputUsdPerMillion: price?.input ?? null,
    cachedInputUsdPerMillion: price?.cachedInput ?? null,
    outputUsdPerMillion: price?.output ?? null,
    estimatedUsd,
    usdKrwRate: USD_KRW_RATE,
    estimatedKrw: estimatedUsd === null ? null : estimatedUsd * USD_KRW_RATE,
    pricingAsOf: OPENAI_PRICING_AS_OF,
    fxRateAsOf: USD_KRW_RATE_AS_OF,
    fxRateSource: USD_KRW_RATE_SOURCE,
  };
}
