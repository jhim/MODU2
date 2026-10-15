import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { MockAiService, OpenAiService } from '../../server/src/services/ai.js';
import { buildFlashcardPromptMessages, buildSuggestionPromptMessages } from '../../server/src/prompts/index.js';
import { GeneratedSetSchema } from '../../shared/schemas/index.js';

const topics = ['열대 우림의 대표적인 포유류', '한국의 지역별 문화적 특징', '7급 한자 시험 필수 한자',
  '초등학교 영어 단어', '프랑스 혁명', '세계 각국의 전통 음식 퀴즈'];
const inputFor = (topic: string) => ({ original_request: topic, selected_topic: topic,
  learning_goal: '주요 항목의 뜻과 특징 이해', client_request_id: crypto.randomUUID() });

describe('new flashcard generation', () => {
  it.each(topics)('generates ten distinct, schema-compatible mock cards for %s', async topic => {
    const { data, usage } = await new MockAiService().generate(inputFor(topic), 'local');
    expect(GeneratedSetSchema.safeParse(data).success).toBe(true);
    expect(data.cards).toHaveLength(10);
    expect(new Set(data.cards.map(card => card.key)).size).toBe(10);
    expect(usage).toBeNull();
    if (!topic.includes('퀴즈')) expect(data.cards.every(card => !/[?？]|인가요|무엇/.test(card.key))).toBe(true);
    if (topic.includes('한자')) {
      expect(data.title).toContain('급수 미확인');
      expect(data.cards.every(card => /^\p{Script=Han}$/u.test(card.key))).toBe(true);
      expect(data.cards.find(card => card.key === '生')?.values.join(' ')).toContain('날 생');
      expect(data.cards.find(card => card.key === '山')?.values.join(' ')).toContain('메 산');
    }
    if (topic.includes('영어')) expect(data.cards.every(card => /^[a-z]+$/i.test(card.key))).toBe(true);
    if (topic.includes('포유류')) expect(data.cards.map(card => card.key)).toEqual(expect.arrayContaining(['재규어', '오랑우탄', '다람쥐원숭이']));
    if (topic.includes('퀴즈')) expect(data.cards.every(card => card.key.endsWith('?'))).toBe(true);
  });

  it('distinguishes a question-shaped topic from explicit quiz requests and quiz opt-out in mocks', async () => {
    const mock = new MockAiService();
    const input = inputFor(topics[0]);
    const ordinary = await mock.generate({ ...input, original_request: '열대 우림의 대표적인 포유류는?' }, 'local');
    expect(ordinary.data.cards[0].key).toBe('재규어');
    const quiz = await mock.generate({ ...input, original_request: '열대 우림의 포유류를 질문형 학습으로 만들어줘' }, 'local');
    expect(quiz.data.cards[0].key).toContain('설명해 보세요');
    const noQuiz = await mock.generate({ ...input, original_request: '열대 우림의 포유류, 퀴즈 말고 설명으로' }, 'local');
    expect(noQuiz.data.cards[0].key).toBe('재규어');
  });

  it('preserves refinement and previous titles as data in the shared preview/request messages', () => {
    const messages = buildSuggestionPromptMessages({ original_request: '열대 우림 포유류',
      refinement_request: '초등학생 수준, 질문형 퀴즈 말고 설명', previous_suggestions: [{ title: '대표 포유류' }] });
    expect(messages.map(message => message.role)).toEqual(['system', 'developer', 'user']);
    expect(JSON.parse(messages[2].content)).toEqual({ original_request: '열대 우림 포유류',
      refinement_request: '초등학생 수준, 질문형 퀴즈 말고 설명', previous_titles: ['대표 포유류'] });
  });

  it.each(topics)('sends the actual card rules and request data without changing schema or usage for %s', async topic => {
    const input = inputFor(topic);
    const fixture = (await new MockAiService().generate(input, 'fixture')).data;
    let outbound: any;
    const client = new OpenAI({ apiKey: 'local-test-only', maxRetries: 0, fetch: async (_url, init) => {
      outbound = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: 'local-completion', object: 'chat.completion', created: 1,
        model: 'gpt-4o-mini', choices: [{ index: 0, finish_reason: 'stop', message: {
          role: 'assistant', content: JSON.stringify(fixture) } }],
        usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    } });
    const result = await new OpenAiService('local-test-only', 'gpt-4o-mini', client).generate(input, 'local');
    expect(outbound.messages).toEqual(buildFlashcardPromptMessages(input));
    expect(JSON.parse(outbound.messages[2].content)).toEqual({ original_request: topic, selected_topic: topic,
      learning_goal: input.learning_goal, card_count: 10, language: 'ko' });
    expect(outbound.response_format.json_schema.name).toBe('learning_flashcards');
    expect(outbound.max_completion_tokens).toBe(5600);
    expect(result.data).toEqual(fixture);
    expect(result.usage).toMatchObject({ inputTokens: 120, outputTokens: 80, totalTokens: 200 });
    expect(JSON.stringify(outbound.messages)).not.toContain('local-test-only');
  });
});
