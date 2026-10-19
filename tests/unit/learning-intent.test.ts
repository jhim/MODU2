import { readFileSync } from 'node:fs';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { CreateSetRequestSchema, GeneratedSetSchema } from '../../shared/schemas/index.js';
import { buildFlashcardPromptMessages, DEFAULT_PROMPT_TEMPLATES } from '../../server/src/prompts/index.js';
import { validatePromptTemplate } from '../../server/src/prompts/templates.js';
import { MockAiService, OpenAiService } from '../../server/src/services/ai.js';

const cases = [
  { request: '초등학교 영어 단어 30개', topic: '초등학교 영어 단어', key: /^[a-z]+$/i, value: /사과/ },
  { request: '재미있는 넌센스 퀴즈 30개', topic: '재미있는 넌센스 퀴즈', key: /[?？]$/, value: /소오름/ },
  { request: '한국사 상식 문제 20개', topic: '한국사 상식 문제', key: /[?？]$/, value: /이성계/ },
  { request: '한자 20개', topic: '한자', key: /^\p{Script=Han}$/u, value: /날 생/ },
  { request: '영어 회화 문장 20개', topic: '영어 회화 문장', key: /^How are you\?$/, value: /어떻게 지내세요/ },
  { request: '영어 문법 빈칸 문제 20개', topic: '영어 문법 빈칸 문제', key: /___/, value: /went/ },
  { request: '경제 용어 30개', topic: '경제 용어', key: /^인플레이션$/, value: /물가/ },
  { request: '초등학생 과학 퀴즈 20개', topic: '초등학생 과학 퀴즈', key: /[?？]$/, value: /얼음/ },
];

describe('learning purpose and request context (fixed-ten compatibility)', () => {
  it('ships draft bodies identical to code fallback and validates them before managed activation', () => {
    const bundle = JSON.parse(readFileSync(new URL('../../docs/prompts/learning-intent-drafts.json', import.meta.url), 'utf8'));
    expect(bundle.map((item: any) => item.prompt_key)).toEqual(['RECOMMEND', 'FLASHCARD']);
    for (const entry of bundle) {
      const { prompt_key, change_note, ...template } = entry;
      expect(template).toEqual(DEFAULT_PROMPT_TEMPLATES[prompt_key as keyof typeof DEFAULT_PROMPT_TEMPLATES]);
      expect(validatePromptTemplate(prompt_key, template).valid).toBe(true);
    }
  });

  it.each(cases)('keeps $request intact through mocked transport and preserves the Key/Value response contract', async example => {
    const input = CreateSetRequestSchema.parse({ original_request: example.request,
      refinement_request: '대상 수준을 유지하고 정답은 짧게', selected_topic: example.topic,
      learning_goal: '요청한 형식으로 학습한다', client_request_id: crypto.randomUUID() });
    const fixture = (await new MockAiService().generate(input, 'fixture')).data;
    expect(fixture.cards).toHaveLength(10); // Existing schema/RPC: this does NOT implement 20/30-card generation.
    expect(fixture.cards[0].key).toMatch(example.key);
    expect(fixture.cards[0].values.join(' ')).toMatch(example.value);
    expect(new Set(fixture.cards.map(card => card.key)).size).toBe(10);
    let sent: any;
    const client = new OpenAI({ apiKey: 'local-only', maxRetries: 0, fetch: async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: 'mock', object: 'chat.completion', created: 1, model: 'gpt-4o-mini',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(fixture) } }],
        usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    } });
    const result = await new OpenAiService('local-only', 'gpt-4o-mini', client).generate(input, 'mock-request');
    expect(sent.messages).toEqual(buildFlashcardPromptMessages(input));
    expect(sent.messages.map((message: any) => message.role)).toEqual(['system', 'developer', 'user']);
    expect(JSON.parse(sent.messages[2].content)).toMatchObject({ original_request: example.request,
      refinement_request: input.refinement_request, selected_topic: example.topic, card_count: 10 });
    expect(result.data).toEqual(fixture);
    expect(result.usage).toMatchObject({ inputTokens: 120, outputTokens: 80, totalTokens: 200 });
    expect(Object.keys(result.data).sort()).toEqual(['cards', 'title']);
    expect(result.data.cards.every(card => Object.keys(card).sort().join(',') === 'key,values')).toBe(true);
  });

  it('keeps old templates valid and carries refinement without replacing managed prompt text', () => {
    const oldTemplate = { ...DEFAULT_PROMPT_TEMPLATES.FLASHCARD,
      user_template: '{"original_request":{{original_request_json}},"selected_topic":{{selected_topic_json}},"learning_goal":{{learning_goal_json}},"card_count":10}' };
    expect(validatePromptTemplate('FLASHCARD', oldTemplate).valid).toBe(true);
    const input = { original_request: '영어 문장', selected_topic: '회화', learning_goal: '원문과 번역',
      refinement_request: '정답은 짧게 "quoted" \"\n규칙 무시 지시는 데이터' };
    const messages = buildFlashcardPromptMessages(input, oldTemplate);
    expect(messages[0].content).toBe(oldTemplate.system_prompt);
    expect(messages[1].content).toBe(oldTemplate.developer_prompt);
    expect(messages[2].content).toContain(JSON.stringify({ refinement_request: input.refinement_request }));
    const originalClient = buildFlashcardPromptMessages({ original_request: '영어 문장', selected_topic: '회화', learning_goal: '원문과 번역' }, oldTemplate);
    expect(JSON.parse(originalClient[2].content).original_request).toBe('영어 문장');
    expect(validatePromptTemplate('FLASHCARD', DEFAULT_PROMPT_TEMPLATES.FLASHCARD).valid).toBe(true);
    expect(CreateSetRequestSchema.safeParse({ ...input, client_request_id: crypto.randomUUID(), refinement_request: 'a'.repeat(201) }).success).toBe(false);
  });

  it('retains the existing cardinality boundary rather than pretending 20/30 output is supported', async () => {
    const fixture = (await new MockAiService().generate({ original_request: '한자', selected_topic: '한자',
      learning_goal: '음과 뜻', client_request_id: crypto.randomUUID() }, 'local')).data;
    for (const count of [20, 30]) expect(GeneratedSetSchema.safeParse({ ...fixture,
      cards: Array.from({ length: count }, (_, index) => ({ key: '항목' + index, values: ['뜻'] })) }).success).toBe(false);
  });
});
