import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { createApp } from '../../server/src/app.js';
import { MemoryLearningRepository } from '../../server/src/repositories/memory.js';
import { OpenAiService } from '../../server/src/services/ai.js';

describe('public recommendation prompt confidentiality', () => {
  let server: ReturnType<ReturnType<typeof createApp>['listen']>;
  let baseUrl = '';
  let outbound: any;
  beforeAll(async () => {
    const client = new OpenAI({ apiKey: 'local-only-test-key', maxRetries: 0, fetch: async (_url, init) => {
      outbound = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: 'local-prompt-test', object: 'chat.completion', created: 1, model: 'gpt-4o-mini',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ message: '학습 방향을 골라 주세요.', suggestions: [
          { id: 'one', title: '추천 주제 하나', description: '설명', learning_goal: '이해한다' },
          { id: 'two', title: '추천 주제 둘', description: '설명', learning_goal: '비교한다' },
        ] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    } });
    const app = createApp({ ai: new OpenAiService('local-only-test-key', 'gpt-4o-mini', client), repository: new MemoryLearningRepository() });
    server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
    baseUrl = 'http://127.0.0.1:' + (server.address() as any).port;
  });
  afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); });
  it('keeps internal prompt messages out of the public response while still sending them upstream', async () => {
    const response = await fetch(baseUrl + '/api/ai/suggestions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ original_request: '로컬 프롬프트 보안 확인', refinement_request: '', previous_suggestions: [] }) });
    const body = await response.json(); const serialized = JSON.stringify(body);
    expect(response.status).toBe(200);
    for (const key of ['request_prompt', 'messages', 'system_prompt', 'developer_prompt', 'user_template']) expect(body).not.toHaveProperty(key);
    expect(serialized).not.toContain('local-only-test-key');
    expect(outbound.messages.map((message: { role: string }) => message.role)).toEqual(['system', 'developer', 'user']);
  });
});
