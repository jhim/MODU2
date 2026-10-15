import OpenAI, { APIError } from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { GeneratedSetSchema, SuggestionsResponseSchema, type CreateSetRequest, type SuggestionsResponse } from '../../../shared/schemas/index.js';
import { FLASHCARD_DEVELOPER_PROMPT, FLASHCARD_SYSTEM_PROMPT, IMAGE_EXTRACTION_DEVELOPER_PROMPT,
  IMAGE_EXTRACTION_SYSTEM_PROMPT, SUGGESTION_DEVELOPER_PROMPT, SUGGESTION_SYSTEM_PROMPT,
  buildSuggestionPromptMessages, type SuggestionPromptMessage } from '../prompts/index.js';
import { logMetric } from '../lib/metrics.js';
import { calculateAiUsage, type AiUsageRecord } from './ai-pricing.js';

export type AiCallResult<T> = { data: T; usage: AiUsageRecord | null; requestPrompt?: SuggestionPromptMessage[] };

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
  async suggest(input: { original_request: string; refinement_request: string; previous_suggestions: unknown[] }, _requestId: string): Promise<AiCallResult<SuggestionsResponse>> {
    const original = input.original_request.trim();
    const refinement = input.refinement_request.trim();
    const subject = refinement
      ? (refinement.toLocaleLowerCase().includes(original.toLocaleLowerCase()) ? refinement : `${original} ${refinement}`)
      : original;
    const commonTopics: Record<string, { title: string; description: string; learning_goal: string }[]> = {
      '와인': [
        { title: '와인의 역사', description: '와인의 기원과 시대별 발전을 살펴봅니다.', learning_goal: '와인이 발전해 온 주요 흐름을 설명할 수 있다' },
        { title: '와인의 종류와 특징', description: '색과 양조 방식에 따른 와인의 차이를 구분합니다.', learning_goal: '대표적인 와인 종류와 특징을 구분할 수 있다' },
        { title: '와인 제조 과정', description: '포도 수확부터 발효와 숙성까지의 과정을 살펴봅니다.', learning_goal: '와인이 만들어지는 주요 단계를 설명할 수 있다' },
      ],
      '각 나라별 와인의 특징': [
        { title: '세계 주요 국가별 와인의 특징', description: '여러 와인 생산국의 대표적인 특징을 함께 살펴봅니다.', learning_goal: '주요 국가별 와인의 공통점과 특징을 설명할 수 있다' },
        { title: '나라별 와인 품종과 맛의 차이', description: '여러 국가에서 재배되는 품종과 맛의 차이를 비교합니다.', learning_goal: '국가별 품종과 와인 맛의 차이를 비교할 수 있다' },
        { title: '나라별 와인 생산 환경과 문화', description: '여러 국가의 기후·재배 환경과 와인 문화를 비교합니다.', learning_goal: '생산 환경과 문화가 국가별 와인에 미치는 영향을 설명할 수 있다' },
      ],
      '세계 각국의 음식 문화': [
        { title: '세계 주요 국가의 음식 문화', description: '여러 나라의 식사 방식과 대표적인 음식 문화를 살펴봅니다.', learning_goal: '여러 국가 음식 문화의 공통점과 차이를 설명할 수 있다' },
        { title: '나라별 식재료와 조리 방식', description: '지역마다 다른 주요 식재료와 조리 방식을 비교합니다.', learning_goal: '국가별 식재료와 조리 방식의 특징을 비교할 수 있다' },
        { title: '음식 문화에 담긴 역사와 생활', description: '여러 나라의 음식 문화가 역사와 생활 환경에 따라 형성된 모습을 알아봅니다.', learning_goal: '음식 문화와 각국의 역사·생활 환경의 관계를 설명할 수 있다' },
      ],
      '자동차 브랜드별 특징': [
        { title: '주요 자동차 브랜드별 특징', description: '여러 자동차 브랜드의 설계 방향과 대표 특징을 비교합니다.', learning_goal: '주요 브랜드의 공통점과 차이를 설명할 수 있다' },
        { title: '브랜드별 자동차 기술과 강점', description: '여러 브랜드가 강조하는 기술과 강점을 비교합니다.', learning_goal: '브랜드별 기술과 강점을 기준에 따라 비교할 수 있다' },
        { title: '자동차 브랜드의 디자인과 시장 전략', description: '여러 브랜드의 디자인 방향과 시장 전략을 살펴봅니다.', learning_goal: '브랜드별 디자인·시장 전략의 차이를 설명할 수 있다' },
      ],
      '시대별 세계사': [
        { title: '시대별 세계사의 주요 변화', description: '여러 시대의 주요 사건과 사회 변화를 흐름에 따라 살펴봅니다.', learning_goal: '시대별 세계사의 변화와 연결 관계를 설명할 수 있다' },
        { title: '시대에 따른 문명과 사회의 비교', description: '서로 다른 시대의 문명과 사회 구조를 비교합니다.', learning_goal: '여러 시대의 문명·사회 특징을 비교할 수 있다' },
        { title: '시대별 교류와 기술의 발전', description: '여러 시대의 지역 간 교류와 기술 변화를 함께 살펴봅니다.', learning_goal: '시대별 교류와 기술 발전의 차이를 설명할 수 있다' },
      ],
      '프랑스 와인의 특징': [
        { title: '프랑스 와인의 주요 특징', description: '프랑스 와인의 지역·품종·생산 방식에 따른 특징을 살펴봅니다.', learning_goal: '프랑스 와인의 대표적인 특징을 설명할 수 있다' },
        { title: '프랑스 와인 산지와 품종', description: '프랑스의 주요 와인 산지와 재배 품종을 알아봅니다.', learning_goal: '프랑스 주요 산지와 품종의 관계를 설명할 수 있다' },
        { title: '프랑스 와인의 맛과 양조 방식', description: '프랑스 와인의 맛을 품종과 양조 방식에 연결해 살펴봅니다.', learning_goal: '프랑스 와인의 맛과 양조 방식의 관계를 설명할 수 있다' },
      ],
      '피아노': [
        { title: '악보의 기본 구성 요소', description: '오선, 음자리표, 음표와 박자표를 익힙니다.', learning_goal: '악보의 기본 기호와 역할을 설명할 수 있다' },
        { title: '피아노 건반과 음계', description: '건반 배열과 기본 음계의 관계를 알아봅니다.', learning_goal: '건반에서 기본 음계의 위치를 찾을 수 있다' },
        { title: '피아노 연주 기초', description: '바른 자세와 손가락 번호, 기본 연습법을 익힙니다.', learning_goal: '기초적인 연주 자세와 연습법을 적용할 수 있다' },
      ],
      '세계사': [
        { title: '17세기 세계사', description: '17세기 주요 지역의 변화와 교류를 살펴봅니다.', learning_goal: '17세기 주요 사건과 지역 간 관계를 설명할 수 있다' },
        { title: '산업혁명의 배경과 영향', description: '산업혁명이 시작된 배경과 사회 변화를 알아봅니다.', learning_goal: '산업혁명의 원인과 영향을 연결해 설명할 수 있다' },
        { title: '고대 문명의 특징', description: '강 유역에서 성장한 고대 문명의 공통점과 차이를 봅니다.', learning_goal: '고대 문명의 대표 특징을 비교할 수 있다' },
      ],
      '17세기 세계사': [
        { title: '17세기 세계사의 주요 사건과 변화', description: '17세기에 여러 지역에서 일어난 주요 변화를 살펴봅니다.', learning_goal: '17세기의 주요 사건과 변화를 시대 범위 안에서 설명할 수 있다' },
        { title: '17세기 유럽과 아시아의 교류', description: '17세기 유럽과 아시아 사이의 교류와 영향을 알아봅니다.', learning_goal: '17세기 두 지역의 교류 사례를 설명할 수 있다' },
        { title: '17세기 과학과 문화의 변화', description: '17세기 과학 지식과 문화의 변화를 살펴봅니다.', learning_goal: '17세기 과학·문화 변화의 특징을 설명할 수 있다' },
      ],
      '영어 단어': [
        { title: '초등학교 4학년 영어 단어', description: '학교와 일상에서 자주 쓰는 기초 어휘를 익힙니다.', learning_goal: '기초 영어 단어의 뜻과 쓰임을 이해할 수 있다' },
        { title: '일상생활 필수 영어 단어', description: '인사, 집, 음식 등 일상 주제별 어휘를 배웁니다.', learning_goal: '일상 상황에 필요한 기본 어휘를 사용할 수 있다' },
        { title: '여행 영어 단어', description: '교통, 숙소와 식당에서 자주 쓰는 어휘를 익힙니다.', learning_goal: '여행 상황에 맞는 핵심 어휘를 알아볼 수 있다' },
      ],
      '초등학교 4학년 영어 단어': [
        { title: '초등학교 4학년 필수 영어 단어', description: '초등학교 4학년 수준의 기초 어휘를 익힙니다.', learning_goal: '초등학교 4학년 필수 어휘의 뜻을 이해할 수 있다' },
        { title: '초등학교 4학년 생활 영어 단어', description: '일상생활에서 쓰이는 초등학교 4학년 수준의 어휘를 배웁니다.', learning_goal: '초등학교 4학년 생활 어휘를 상황에 맞게 이해할 수 있다' },
        { title: '초등학교 4학년 학교생활 영어 단어', description: '교실과 학교생활에 필요한 초등학교 4학년 수준의 어휘를 익힙니다.', learning_goal: '학교생활에 필요한 초등학교 4학년 어휘를 이해할 수 있다' },
      ],
      '열대 우림의 대표적인 포유류는': [
        { title: '열대 우림에 사는 대표적인 포유류', description: '열대 우림에 서식하는 여러 포유류의 종류와 특징을 살펴봅니다.', learning_goal: '대표적인 열대 우림 포유류 여러 종의 특징을 설명할 수 있다' },
        { title: '지역별 열대 우림 포유류', description: '지역에 따라 서식하는 열대 우림 포유류의 다양성을 비교합니다.', learning_goal: '지역별 열대 우림 포유류의 공통점과 차이를 설명할 수 있다' },
        { title: '열대 우림 포유류의 생활 방식', description: '여러 포유류의 먹이 활동과 이동·생활 방식을 살펴봅니다.', learning_goal: '열대 우림 포유류의 다양한 생활 방식을 설명할 수 있다' },
      ],
      '열대 우림에 사는 동물': [
        { title: '열대 우림에 사는 대표 동물', description: '열대 우림에 사는 여러 동물 무리와 대표 종을 살펴봅니다.', learning_goal: '열대 우림 동물의 다양한 종류를 설명할 수 있다' },
        { title: '지역별 열대 우림 동물', description: '지역에 따라 다른 열대 우림 동물의 분포와 다양성을 비교합니다.', learning_goal: '지역별 열대 우림 동물의 차이를 설명할 수 있다' },
        { title: '열대 우림 동물의 생활 방식', description: '여러 동물이 먹이를 얻고 서식 환경에 적응하는 방식을 살펴봅니다.', learning_goal: '열대 우림 동물의 다양한 생활 방식을 설명할 수 있다' },
      ],
      '재규어의 생태': [
        { title: '재규어의 생태와 특징', description: '재규어의 몸의 특징과 생활 주기를 살펴봅니다.', learning_goal: '재규어의 주요 생태적 특징을 설명할 수 있다' },
        { title: '재규어의 먹이와 사냥 방식', description: '재규어의 먹이 활동과 사냥 방식을 알아봅니다.', learning_goal: '재규어의 먹이와 사냥 방식을 설명할 수 있다' },
        { title: '재규어의 서식 환경', description: '재규어가 살아가는 환경과 그곳에서의 생활을 살펴봅니다.', learning_goal: '재규어의 서식 환경 특징을 설명할 수 있다' },
      ],
    };
    const normalizedSubject = subject.trim().toLocaleLowerCase().replace(/[?？。!！]+$/u, '');
    const scopedTopics = commonTopics[normalizedSubject] ?? [
      { title: `${subject}의 주요 용어와 원리`, description: `${subject}의 기본 용어와 작동 원리를 익힙니다.`, learning_goal: `${subject}의 주요 용어와 원리를 설명할 수 있다` },
      { title: `${subject}의 종류와 차이`, description: `${subject}의 대표적인 유형과 차이를 비교합니다.`, learning_goal: `${subject}의 대표 유형을 구분할 수 있다` },
      { title: `${subject}의 기본 활용법`, description: `${subject}를 실제 상황에 적용하는 기초를 배웁니다.`, learning_goal: `${subject}의 기초를 실제 상황에 적용할 수 있다` },
    ];
    return { data: SuggestionsResponseSchema.parse({
      message: subject + '에 대해 어떤 내용을 학습하고 싶으세요?',
      suggestions: scopedTopics.map((topic, index) => ({ id: `s${index + 1}`, ...topic })),
    }), usage: null, requestPrompt: buildSuggestionPromptMessages(input) };
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
    const requestPrompt = buildSuggestionPromptMessages(input);
    const response = await this.request('suggestions', id, () => this.client.chat.completions.parse({
      model: this.model,
      messages: requestPrompt,
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
    try { return { data: SuggestionsResponseSchema.parse(content), usage, requestPrompt }; }
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
