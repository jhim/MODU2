import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server/src/app.js';
import { MemoryLearningRepository } from '../../server/src/repositories/memory.js';
import { MockAiService } from '../../server/src/services/ai.js';

const repository = new MemoryLearningRepository();
const ai = new MockAiService();
const verifyTestAccessToken = async (token: string) => token === 'test-user' ? { id: 'test-user', email: 'test@example.com' } : null;
const authenticatedJson = { 'content-type': 'application/json', authorization: 'Bearer test-user' };
const app = createApp({ ai, repository, enableTestRoutes: true, verifyAccessToken: verifyTestAccessToken });
let server: ReturnType<typeof app.listen>;
let baseUrl = '';
beforeAll(async () => { server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve)); baseUrl = `http://127.0.0.1:${(server.address() as any).port}`; });
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

describe('new flashcards preserve existing content', () => {
  it('leaves previously saved question-style cards unchanged when new cards are generated', async () => {
    const reserved = await repository.reserve({ requestId: crypto.randomUUID(), originalRequest: '기존 학습',
      selectedTopic: '기존 질문형 콘텐츠', learningGoal: '기존 데이터 보존' });
    await repository.complete(reserved.set.id, '기존 질문형 콘텐츠', Array.from({ length: 10 }, (_, index) => ({
      key: `기존 질문 ${index + 1}은 무엇인가요?`, values: [`기존 정답 ${index + 1}`],
    })));
    const before = await fetch(`${baseUrl}/api/learning-sets/${reserved.set.id}`).then(response => response.json());
    const response = await fetch(`${baseUrl}/api/learning-sets`, { method: 'POST', headers: authenticatedJson,
      body: JSON.stringify({ original_request: '열대 우림의 대표적인 포유류', selected_topic: '열대 우림의 대표적인 포유류',
        learning_goal: '여러 포유류의 특징 이해', client_request_id: crypto.randomUUID() }) });
    expect(response.status).toBe(201);
    expect((await response.json()).cards[0].key).toBe('재규어');
    const after = await fetch(`${baseUrl}/api/learning-sets/${reserved.set.id}`).then(response => response.json());
    expect(after).toEqual(before);
  });
});
