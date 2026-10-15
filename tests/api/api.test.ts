import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../server/src/app.js';
import { MemoryLearningRepository } from '../../server/src/repositories/memory.js';
import { MockAiService } from '../../server/src/services/ai.js';
import { GeneratedSetSchema } from '../../shared/schemas/index.js';

const repository = new MemoryLearningRepository();
const ai = new MockAiService();
const app = createApp({ ai, repository, enableTestRoutes: true });
let server: ReturnType<typeof app.listen>;
let baseUrl = '';
beforeAll(async () => { server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve)); baseUrl = `http://127.0.0.1:${(server.address() as any).port}`; });
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

describe('MODU2 API', () => {
  it('searches only stored completed content and does not call AI', async () => {
    const aiSpy = vi.spyOn(ai, 'suggest');
    const seed = await fetch(`${baseUrl}/api/test/seed`, { method: 'POST' }).then(r => r.json());
    const response = await fetch(`${baseUrl}/api/learning-sets/search?q=${encodeURIComponent('와')}`);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].id).toBe(seed.id);
    expect(aiSpy).not.toHaveBeenCalled();
  });
  it.each(['%', '_', '\\'])('passes %s as a literal search character', async (special) => {
    const requestId = crypto.randomUUID();
    const literal = `literal-search-${requestId}${special}tail`;
    const created = await repository.reserve({ requestId, originalRequest: literal, selectedTopic: literal,
      learningGoal: '특수문자 검색 확인' });
    await repository.complete(created.set.id, literal, Array.from({ length: 10 }, (_, i) => ({
      key: `literal-card-${requestId}-${i}`, values: ['검색 테스트'],
    })));

    const response = await fetch(`${baseUrl}/api/learning-sets/search?q=${encodeURIComponent(special)}`);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.results.some((result: { id: string }) => result.id === created.set.id)).toBe(true);
  });
  it('returns 2–3 recommendations and accepts refinement context', async () => {
    const response = await fetch(`${baseUrl}/api/ai/suggestions`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ original_request: '와인', refinement_request: '음식 페어링', previous_suggestions: [] }) });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.suggestions.length).toBeGreaterThanOrEqual(2);
    expect(body.suggestions.length).toBeLessThanOrEqual(3);
    expect(body.message).toContain('음식 페어링');
  });
  it('generates and stores ten cards idempotently, then reads without AI', async () => {
    const input = { original_request: '와인', selected_topic: '와인 기초', learning_goal: '기본을 안다', client_request_id: crypto.randomUUID() };
    const generateSpy = vi.spyOn(ai, 'generate');
    const first = await fetch(`${baseUrl}/api/learning-sets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    const set = await first.json();
    expect(first.status).toBe(201);
    expect(set.cards).toHaveLength(10);
    const duplicate = await fetch(`${baseUrl}/api/learning-sets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    expect(duplicate.status).toBe(200);
    expect(generateSpy).toHaveBeenCalledTimes(1);
    const read = await fetch(`${baseUrl}/api/learning-sets/${set.id}`);
    expect(read.status).toBe(200);
    expect((await read.json()).cards).toHaveLength(10);
    expect(generateSpy).toHaveBeenCalledTimes(1);
  });
  it('retries one structured-output validation failure before storing cards', async () => {
    const mock = new MockAiService();
    const invalid = GeneratedSetSchema.safeParse({ title: '', cards: [] });
    const generate = vi.fn().mockRejectedValueOnce(invalid.error).mockImplementation((input, id) => mock.generate(input, id));
    const retryApp = createApp({ ai: { suggest: mock.suggest.bind(mock), generate }, repository: new MemoryLearningRepository() });
    const retryServer = retryApp.listen(0); await new Promise<void>(resolve => retryServer.once('listening', resolve));
    const url = `http://127.0.0.1:${(retryServer.address() as any).port}`;
    try {
      const body = { original_request: '피아노', selected_topic: '피아노 기초', learning_goal: '기본을 안다', client_request_id: crypto.randomUUID() };
      const response = await fetch(`${url}/api/learning-sets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(201);
      expect((await response.json()).cards).toHaveLength(10);
      expect(generate).toHaveBeenCalledTimes(2);
    } finally { await new Promise<void>(resolve => retryServer.close(() => resolve())); }
  });
  it('marks failed generation and never exposes partial content', async () => {
    const brokenAi = { ...ai, suggest: ai.suggest.bind(ai), generate: vi.fn().mockRejectedValue(new Error('upstream secret')) };
    const brokenRepo = new MemoryLearningRepository();
    const brokenApp = createApp({ ai: brokenAi, repository: brokenRepo });
    const brokenServer = brokenApp.listen(0); await new Promise<void>(resolve => brokenServer.once('listening', resolve));
    const url = `http://127.0.0.1:${(brokenServer.address() as any).port}`;
    try {
      const body = { original_request: 'x', selected_topic: 'x', learning_goal: 'x', client_request_id: crypto.randomUUID() };
      const response = await fetch(`${url}/api/learning-sets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(500);
      expect((await response.text())).not.toContain('upstream secret');
    } finally { await new Promise<void>(resolve => brokenServer.close(() => resolve())); }
  });
});
