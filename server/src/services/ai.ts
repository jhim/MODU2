import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { GeneratedSetSchema, SuggestionsResponseSchema, type CreateSetRequest, type SuggestionsResponse } from '../../../shared/schemas/index.js';
import { FLASHCARD_SYSTEM_PROMPT, SUGGESTION_SYSTEM_PROMPT } from '../prompts/index.js';
import { logMetric } from '../lib/metrics.js';

export interface AiService {
  suggest(input: { original_request: string; refinement_request: string; previous_suggestions: unknown[] }, requestId: string): Promise<SuggestionsResponse>;
  generate(input: CreateSetRequest, requestId: string): Promise<{ title: string; cards: { key: string; values: string[] }[] }>;
}

export class MockAiService implements AiService {
  async suggest(input: { original_request: string; refinement_request: string }, _requestId: string): Promise<SuggestionsResponse> {
    const subject = input.refinement_request || input.original_request;
    return SuggestionsResponseSchema.parse({
      message: `${subject}에 대해 어떤 내용을 학습하고 싶으세요?`,
      suggestions: [
        { id: 's1', title: `${subject} 핵심 개념`, description: `${subject}의 기본 원리와 주요 용어`, learning_goal: `${subject}의 핵심 개념을 설명할 수 있다` },
        { id: 's2', title: `${subject} 구성과 종류`, description: `${subject}를 이루는 요소와 대표적인 분류`, learning_goal: `${subject}의 주요 종류를 구분할 수 있다` },
        { id: 's3', title: `${subject} 실전 활용`, description: `${subject}를 일상과 실제 상황에 적용하는 방법`, learning_goal: `${subject}의 기본 지식을 실제 사례에 적용할 수 있다` },
      ],
    });
  }
  async generate(input: CreateSetRequest, _requestId: string): Promise<{ title: string; cards: { key: string; values: string[] }[] }> {
    const topic = input.selected_topic;
    const cards = Array.from({ length: 10 }, (_, i) => ({
      key: `${topic} 핵심 항목 ${i + 1}`,
      values: [`${topic} 학습에서 알아둘 핵심 내용 ${i + 1}입니다.`, '관련 개념과 실제 사례를 함께 살펴보세요.'],
    }));
    return GeneratedSetSchema.parse({ title: topic, cards });
  }
}

export class OpenAiService implements AiService {
  private readonly client: OpenAI;
  constructor(apiKey: string, private readonly model: string) { this.client = new OpenAI({ apiKey }); }
  async suggest(input: { original_request: string; refinement_request: string; previous_suggestions: unknown[] }, id: string): Promise<SuggestionsResponse> {
    const started = performance.now();
    const response = await this.client.chat.completions.parse({
      model: this.model,
      messages: [
        { role: 'system', content: SUGGESTION_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(input) },
      ],
      response_format: zodResponseFormat(SuggestionsResponseSchema, 'learning_suggestions'),
    });
    const content = response.choices[0]?.message.parsed;
    logMetric('ai_call', { request_id: id, kind: 'suggestions', duration_ms: Math.round(performance.now() - started), model: this.model });
    return SuggestionsResponseSchema.parse(content);
  }
  async generate(input: CreateSetRequest, id: string): Promise<{ title: string; cards: { key: string; values: string[] }[] }> {
    const started = performance.now();
    const response = await this.client.chat.completions.parse({
      model: this.model,
      messages: [
        { role: 'system', content: FLASHCARD_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ original_request: input.original_request, selected_topic: input.selected_topic,
          learning_goal: input.learning_goal, card_count: 10, language: 'ko' }) },
      ],
      response_format: zodResponseFormat(GeneratedSetSchema, 'learning_flashcards'),
    });
    logMetric('ai_call', { request_id: id, kind: 'flashcard_generation', duration_ms: Math.round(performance.now() - started), model: this.model });
    return GeneratedSetSchema.parse(response.choices[0]?.message.parsed);
  }
}
