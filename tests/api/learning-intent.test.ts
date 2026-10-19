import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../server/src/app.js';
import { MemoryLearningRepository } from '../../server/src/repositories/memory.js';
import { MemoryPromptRepository } from '../../server/src/prompts/memory-repository.js';
import { MockAiService } from '../../server/src/services/ai.js';
import { buildFlashcardPromptMessages } from '../../server/src/prompts/index.js';

it('preserves recommendation/refinement context, admin preview, original search and unrelated stored cards', async () => {
  const repository = new MemoryLearningRepository();
  const prompts = new MemoryPromptRepository();
  const ai = new MockAiService();
  const generate = vi.spyOn(ai, 'generate');
  const suggest = vi.spyOn(ai, 'suggest');
  const seed = await repository.reserve({ requestId: crypto.randomUUID(), originalRequest: '기존 검색어',
    selectedTopic: '기존 콘텐츠', learningGoal: '유지' });
  await repository.complete(seed.set.id, '기존 콘텐츠', Array.from({ length: 10 }, (_, index) => ({ key: '기존' + index, values: ['원본'] })));
  const before = structuredClone(await repository.getCompleted(seed.set.id));
  const app = createApp({ ai, repository, promptRepository: prompts, adminUserIds: ['admin-user'],
    verifyAccessToken: async token => token === 'admin-token' ? { id: 'admin-user' } : null });
  const server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as any).port;
  const post = (url: string, body: unknown, admin = false) => fetch(base + url, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(admin ? { authorization: 'Bearer admin-token' } : {}) }, body: JSON.stringify(body) });
  try {
    const original = '재미있는 넌센스 퀴즈 30개';
    const refinement = '초등학생 수준, 정답은 짧게';
    const recommendation = await post('/api/ai/suggestions', { original_request: original, refinement_request: refinement });
    expect(recommendation.status).toBe(200);
    const suggested = await recommendation.json();
    expect(suggest.mock.calls[0]?.[0]).toMatchObject({ original_request: original, refinement_request: refinement });
    const input = { original_request: original, refinement_request: refinement, selected_topic: suggested.suggestions[0].title,
      learning_goal: suggested.suggestions[0].learning_goal, client_request_id: crypto.randomUUID(),
      ai_usage_session_id: suggested.ai_usage_session_id, ai_usage_session_token: suggested.ai_usage_session_token };
    const created = await post('/api/learning-sets', input);
    expect(created.status).toBe(201);
    const content = await created.json();
    expect(generate.mock.calls[0]?.[0]).toMatchObject(input);
    expect(content.original_request).toBe(original);
    expect(content.cards).toHaveLength(10);
    for (const body of [suggested, content]) for (const key of ['request_prompt', 'messages', 'system_prompt', 'developer_prompt', 'user_template']) expect(body).not.toHaveProperty(key);
    expect(await repository.getCompleted(seed.set.id)).toEqual(before);
    const active = await prompts.loadActivePrompt('FLASHCARD');
    const preview = await post('/api/admin/prompts/FLASHCARD/preview', { version_id: active!.id,
      input: { ...input, previous_titles: [] } }, true);
    expect(preview.status).toBe(200);
    expect((await preview.json()).messages).toEqual(buildFlashcardPromptMessages(input, active!));
    expect((await post('/api/admin/prompts/FLASHCARD/preview', { input })).status).toBe(401);
    expect((await fetch(base + '/api/learning-sets/' + content.id).then(response => response.json())).cards).toEqual(content.cards);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
