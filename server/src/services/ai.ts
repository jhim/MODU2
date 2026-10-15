import OpenAI, { APIError } from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { GeneratedSetSchema, SuggestionsResponseSchema, type CreateSetRequest, type SuggestionsResponse } from '../../../shared/schemas/index.js';
import { FLASHCARD_DEVELOPER_PROMPT, FLASHCARD_SYSTEM_PROMPT, IMAGE_EXTRACTION_DEVELOPER_PROMPT,
  IMAGE_EXTRACTION_SYSTEM_PROMPT, SUGGESTION_DEVELOPER_PROMPT, SUGGESTION_SYSTEM_PROMPT } from '../prompts/index.js';
import { logMetric } from '../lib/metrics.js';
import { calculateAiUsage, type AiUsageRecord } from './ai-pricing.js';

export type AiCallResult<T> = { data: T; usage: AiUsageRecord | null };

export interface AiService {
  suggest(input: { original_request: string; refinement_request: string; previous_suggestions: unknown[] }, requestId: string): Promise<AiCallResult<SuggestionsResponse>>;
  generate(input: CreateSetRequest, requestId: string): Promise<AiCallResult<{ title: string; cards: { key: string; values: string[] }[] }>>;
  extractImage(bytes: Buffer, mimeType: 'image/jpeg' | 'image/png' | 'image/webp', requestId: string): Promise<AiCallResult<{ cards: { key: string; values: string[]; needs_review: boolean }[] }>>;
}

const ImageCardsSchema = z.object({
  cards: z.array(z.object({ key: z.string(), values: z.array(z.string()).min(1).max(6), needs_review: z.boolean() })).max(30),
});
type JsonSchemaNode = { properties?: Record<string, JsonSchemaNode>; items?: JsonSchemaNode; [key: string]: unknown };
function removeUnsupportedStringLengths(schema: JsonSchemaNode) {
  delete schema.minLength; delete schema.maxLength;
  if (schema.properties) Object.values(schema.properties).forEach(removeUnsupportedStringLengths);
  if (schema.items) removeUnsupportedStringLengths(schema.items);
  for (const key of ['$defs', 'definitions']) {
    const defs = schema[key] as Record<string, JsonSchemaNode> | undefined;
    if (defs) Object.values(defs).forEach(removeUnsupportedStringLengths);
  }
}
function responseFormat(schema: Parameters<typeof zodResponseFormat>[0], name: string) {
  const format = zodResponseFormat(schema, name);
  removeUnsupportedStringLengths(format.json_schema.schema as JsonSchemaNode);
  return format;
}

export class MockAiService implements AiService {
  async suggest(input: { original_request: string; refinement_request: string }, _requestId: string): Promise<AiCallResult<SuggestionsResponse>> {
    const subject = input.refinement_request || input.original_request;
    return { data: SuggestionsResponseSchema.parse({
      message: subject + '에 대해 어떤 내용을 학습하고 싶으세요?',
      suggestions: [
        { id: 's1', title: subject + ' 핵심 개념', description: subject + '의 기본 원리와 주요 용어', learning_goal: subject + '의 핵심 개념을 설명할 수 있다' },
        { id: 's2', title: subject + ' 구성과 종류', description: subject + '를 이루는 요소와 대표적인 분류', learning_goal: subject + '의 주요 종류를 구분할 수 있다' },
        { id: 's3', title: subject + ' 실전 활용', description: subject + '를 일상과 실제 상황에 적용하는 방법', learning_goal: subject + '의 기본 지식을 실제 사례에 적용할 수 있다' },
      ],
    }), usage: null };
  }
  async generate(input: CreateSetRequest, _requestId: string): Promise<AiCallResult<{ title: string; cards: { key: string; values: string[] }[] }>> {
    const topic = input.selected_topic;
    const cards = Array.from({ length: 10 }, (_, i) => ({
      key: topic + ' 핵심 항목 ' + (i + 1),
      values: [topic + ' 학습에서 알아둘 핵심 내용 ' + (i + 1) + '입니다.', '관련 개념과 실제 사례를 함께 살펴보세요.'],
    }));
    return { data: GeneratedSetSchema.parse({ title: topic, cards }), usage: null };
  }
  async extractImage(_bytes: Buffer, _mimeType: 'image/jpeg' | 'image/png' | 'image/webp', _requestId: string) {
    return { data: { cards: [{ key: '사진에서 확인할 항목', values: ['원본 이미지를 보며 내용을 직접 입력해 주세요.'], needs_review: true }] }, usage: null };
  }
}

export type AiOperation = 'suggestions' | 'flashcard_generation' | 'image_extraction';
export class AiProviderError extends Error {
  constructor(readonly operation: AiOperation, readonly upstreamStatus?: number, readonly usage?: AiUsageRecord | null) {
    super('AI provider request failed.'); this.name = 'AiProviderError';
  }
}
export class OpenAiService implements AiService {
  private readonly client: OpenAI;
  constructor(apiKey: string, private readonly model: string, client?: OpenAI) {
    this.client = client ?? new OpenAI({ apiKey, timeout: 30_000, maxRetries: 1 });
  }
  private async request<T>(operation: AiOperation, id: string, call: () => Promise<T>): Promise<T> {
    try { return await call(); }
    catch (error) {
      const apiError = error instanceof APIError ? error : undefined;
      logMetric('ai_error', { request_id: id, operation, model: this.model,
        error_type: error instanceof Error ? error.name : 'unknown', upstream_status: apiError?.status,
        openai_error_code: apiError?.code ?? undefined, openai_error_type: apiError?.type,
        openai_request_id: apiError?.requestID ?? undefined });
      throw new AiProviderError(operation, apiError?.status);
    }
  }
  async suggest(input: { original_request: string; refinement_request: string; previous_suggestions: unknown[] }, id: string): Promise<AiCallResult<SuggestionsResponse>> {
    const started = performance.now();
    const response = await this.request('suggestions', id, () => this.client.chat.completions.parse({
      model: this.model,
      messages: [
        { role: 'system', content: SUGGESTION_SYSTEM_PROMPT },
        { role: 'developer', content: SUGGESTION_DEVELOPER_PROMPT },
        { role: 'user', content: JSON.stringify({ original_request: input.original_request,
          refinement_request: input.refinement_request,
          previous_titles: input.previous_suggestions.slice(-6).map((item: any) => typeof item?.title === 'string' ? item.title : '').filter(Boolean) }) },
      ],
      response_format: responseFormat(SuggestionsResponseSchema, 'learning_suggestions'),
      max_completion_tokens: 1400,
    }));
    const content = response.choices[0]?.message.parsed;
    const usage = response.usage ? calculateAiUsage({ model: response.model,
      inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens,
      totalTokens: response.usage.total_tokens, cachedInputTokens: response.usage.prompt_tokens_details?.cached_tokens }) : null;
    logMetric('ai_call', { request_id: id, kind: 'suggestions', duration_ms: Math.round(performance.now() - started), model: this.model });
    if (!content) {
      logMetric('ai_response_invalid', { request_id: id, operation: 'suggestions', model: this.model,
        openai_request_id: response._request_id ?? undefined, finish_reason: response.choices[0]?.finish_reason ?? 'missing',
        refused: Boolean(response.choices[0]?.message.refusal) });
      throw new AiProviderError('suggestions', undefined, usage);
    }
    try { return { data: SuggestionsResponseSchema.parse(content), usage }; }
    catch (error) {
      logMetric('ai_response_invalid', { request_id: id, operation: 'suggestions', model: this.model,
        openai_request_id: response._request_id ?? undefined, error_type: error instanceof Error ? error.name : 'unknown' });
      throw new AiProviderError('suggestions', undefined, usage);
    }
  }
  async generate(input: CreateSetRequest, id: string) {
    const started = performance.now();
    const response = await this.request('flashcard_generation', id, () => this.client.chat.completions.parse({
      model: this.model, messages: [
        { role: 'system', content: FLASHCARD_SYSTEM_PROMPT },
        { role: 'developer', content: FLASHCARD_DEVELOPER_PROMPT },
        { role: 'user', content: JSON.stringify({ original_request: input.original_request,
          selected_topic: input.selected_topic, learning_goal: input.learning_goal, card_count: 10, language: 'ko' }) },
      ], response_format: responseFormat(GeneratedSetSchema, 'learning_flashcards'),
      max_completion_tokens: 5600,
    }));
    logMetric('ai_call', { request_id: id, kind: 'flashcard_generation', duration_ms: Math.round(performance.now() - started), model: this.model });
    const content = response.choices[0]?.message.parsed;
    const usage = response.usage ? calculateAiUsage({ model: response.model,
      inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens,
      totalTokens: response.usage.total_tokens, cachedInputTokens: response.usage.prompt_tokens_details?.cached_tokens }) : null;
    if (!content) {
      logMetric('ai_response_invalid', { request_id: id, operation: 'flashcard_generation', model: this.model,
        openai_request_id: response._request_id ?? undefined, finish_reason: response.choices[0]?.finish_reason ?? 'missing',
        refused: Boolean(response.choices[0]?.message.refusal) });
      throw new AiProviderError('flashcard_generation', undefined, usage);
    }
    try { return { data: GeneratedSetSchema.parse(content), usage }; }
    catch (error) {
      if (error instanceof z.ZodError) Object.assign(error, { aiUsage: usage });
      logMetric('ai_response_invalid', { request_id: id, operation: 'flashcard_generation', model: this.model,
        openai_request_id: response._request_id ?? undefined, error_type: error instanceof Error ? error.name : 'unknown' });
      throw error;
    }
  }
  async extractImage(bytes: Buffer, mimeType: 'image/jpeg' | 'image/png' | 'image/webp', id: string) {
    const started = performance.now();
    const dataUrl = 'data:' + mimeType + ';base64,' + bytes.toString('base64');
    const response = await this.request('image_extraction', id, () => this.client.chat.completions.parse({
      model: this.model,
      messages: [
        { role: 'system', content: IMAGE_EXTRACTION_SYSTEM_PROMPT },
        { role: 'developer', content: IMAGE_EXTRACTION_DEVELOPER_PROMPT },
        { role: 'user', content: [
          { type: 'text', text: '이미지의 학습 항목을 보이는 순서대로 전사하세요. 항목은 최대 30개입니다.' },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
        ] },
      ],
      response_format: responseFormat(ImageCardsSchema, 'photo_flashcards'),
      max_completion_tokens: 3200,
    }));
    const content = response.choices[0]?.message.parsed;
    const usage = response.usage ? calculateAiUsage({ model: response.model,
      inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens,
      totalTokens: response.usage.total_tokens, cachedInputTokens: response.usage.prompt_tokens_details?.cached_tokens }) : null;
    logMetric('ai_call', { request_id: id, kind: 'image_extraction', duration_ms: Math.round(performance.now() - started), model: this.model });
    if (!content) {
      logMetric('ai_response_invalid', { request_id: id, operation: 'image_extraction', model: this.model,
        openai_request_id: response._request_id ?? undefined, finish_reason: response.choices[0]?.finish_reason ?? 'missing',
        refused: Boolean(response.choices[0]?.message.refusal) });
      throw new AiProviderError('image_extraction', undefined, usage);
    }
    const cards = content.cards.map((card: z.infer<typeof ImageCardsSchema>['cards'][number]) => ({ ...card, key: card.key.trim(), values: card.values.map((value: string) => value.trim()) }));
    const invalid = cards.some((card: z.infer<typeof ImageCardsSchema>['cards'][number]) => !card.key || card.key.length > 120 || card.values.length < 1 ||
      card.values.length > 6 || card.values.some((value: string) => !value || value.length > 500));
    if (invalid) {
      logMetric('ai_response_invalid', { request_id: id, operation: 'image_extraction', model: this.model,
        openai_request_id: response._request_id ?? undefined, error_type: 'local_validation' });
      throw new AiProviderError('image_extraction', undefined, usage);
    }
    return { data: { cards }, usage };
  }
}
