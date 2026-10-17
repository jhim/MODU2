import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server/src/app.js';
import { MemoryLearningRepository } from '../../server/src/repositories/memory.js';
import { MockAiService } from '../../server/src/services/ai.js';
import { MemoryPromptRepository } from '../../server/src/prompts/memory-repository.js';
import { buildRuntimePromptMessages } from '../../server/src/prompts/runtime.js';

const promptRepository = new MemoryPromptRepository();
const repository = new MemoryLearningRepository();
const users = new Map([['admin-token', { id: 'admin-user', email: 'admin@example.com' }], ['user-token', { id: 'regular-user', email: 'user@example.com' }]]);
const app = createApp({ ai: new MockAiService(), repository, promptRepository, adminUserIds: ['admin-user'],
  verifyAccessToken: async token => users.get(token) ?? null });
let server: ReturnType<typeof app.listen>;
let baseUrl = '';
const headers = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
async function json(path: string, token: string, init: RequestInit = {}) {
  const response = await fetch(baseUrl + path, { ...init, headers: { ...headers(token), ...(init.headers as Record<string, string> ?? {}) } });
  return { response, body: await response.json() };
}
beforeAll(async () => { server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve)); baseUrl = `http://127.0.0.1:${(server.address() as any).port}`; });
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

describe('administrator prompt API', () => {
  it('rejects anonymous and non-admin users and reports allowlist access only after JWT verification', async () => {
    expect((await fetch(baseUrl + '/api/admin/prompts')).status).toBe(401);
    expect((await json('/api/admin/prompts', 'user-token')).response.status).toBe(403);
    expect((await json('/api/admin/access', 'admin-token')).body).toEqual({ is_admin: true });
    expect((await json('/api/admin/access', 'user-token')).body).toEqual({ is_admin: false });
    const adminResponse = await json('/api/admin/prompts', 'admin-token');
    expect(adminResponse.response.status).toBe(200);
    expect(adminResponse.body.prompts[0].versions[0].system_prompt).toEqual(expect.any(String));
    expect(adminResponse.body.prompts[0].versions[0]).not.toHaveProperty('created_by');
    expect(adminResponse.body.prompts[0].versions[0]).not.toHaveProperty('activated_by');
  });

  it('validates templates, saves a draft without changing ACTIVE, activates atomically and rejects stale versions', async () => {
    const before = await promptRepository.loadActivePrompt('RECOMMEND');
    const created = await json('/api/admin/prompts/RECOMMEND/drafts', 'admin-token', { method: 'POST', body: JSON.stringify({ change_note: '검증 초안' }) });
    expect(created.response.status).toBe(201);
    const draftId = created.body.version.id as string;
    const invalid = await json(`/api/admin/prompts/RECOMMEND/drafts/${draftId}/validate`, 'admin-token', { method: 'POST', body: JSON.stringify({
      system_prompt: 'system', developer_prompt: 'developer', user_template: '{{unknown}}',
    }) });
    expect(invalid.response.status).toBe(200);
    expect(invalid.body.valid).toBe(false);

    const editedTemplate = { system_prompt: 'managed system', developer_prompt: 'managed developer',
      user_template: '{"original_request": {{original_request_json}}, "refinement_request": {{refinement_request_json}}, "previous_titles": {{previous_titles_json}}}', change_note: '프롬프트 편집' };
    const saved = await json(`/api/admin/prompts/RECOMMEND/drafts/${draftId}`, 'admin-token', { method: 'PUT', body: JSON.stringify(editedTemplate) });
    expect(saved.response.status).toBe(200);
    expect((await promptRepository.loadActivePrompt('RECOMMEND'))?.id).toBe(before?.id);

    const applied = await json(`/api/admin/prompts/RECOMMEND/versions/${draftId}/activate`, 'admin-token', { method: 'POST', body: JSON.stringify({ expected_active_version_id: before?.id }) });
    expect(applied.response.status).toBe(200);
    expect(applied.body.version.status).toBe('ACTIVE');
    expect((await promptRepository.loadActivePrompt('RECOMMEND'))?.system_prompt).toBe('managed system');
    const stale = await json(`/api/admin/prompts/RECOMMEND/versions/${draftId}/activate`, 'admin-token', { method: 'POST', body: JSON.stringify({ expected_active_version_id: before?.id }) });
    expect(stale.response.status).toBe(409);
    expect((await promptRepository.listPromptAudit('RECOMMEND', 20)).map(item => item.action)).toEqual(['ACTIVATED', 'DRAFT_UPDATED', 'DRAFT_CREATED']);
  });

  it('derives audit actor IDs from the verified session rather than request data', async () => {
    const draft = await json('/api/admin/prompts/FLASHCARD/drafts', 'admin-token', {
      method: 'POST', body: JSON.stringify({ change_note: 'actor test', actor_user_id: 'regular-user', user_id: 'regular-user' }),
    });
    expect(draft.response.status).toBe(201);
    const audit = await promptRepository.listPromptAudit('FLASHCARD', 5);
    expect(audit[0]?.actor_user_id).toBe('admin-user');
  });

  it('restores an old version as a new draft and previews the exact runtime message builder without OpenAI', async () => {
    const current = await promptRepository.loadActivePrompt('RECOMMEND');
    const created = await json('/api/admin/prompts/RECOMMEND/drafts', 'admin-token', { method: 'POST', body: JSON.stringify({ change_note: 'preview draft' }) });
    const draftId = created.body.version.id as string;
    const oldVersion = (await promptRepository.listPromptVersions('RECOMMEND')).find(version => version.version_number === 1)!;
    const restored = await json(`/api/admin/prompts/RECOMMEND/versions/${oldVersion.id}/restore`, 'admin-token', { method: 'POST', body: JSON.stringify({ change_note: 'restore test' }) });
    expect(restored.response.status).toBe(201);
    expect(restored.body.version.status).toBe('DRAFT');
    expect(restored.body.version.system_prompt).toBe(oldVersion.system_prompt);
    expect((await promptRepository.loadActivePrompt('RECOMMEND'))?.id).toBe(current?.id);

    const input = { original_request: '각 나라별 와인', refinement_request: '초급', previous_titles: ['와인 역사'], selected_topic: '세계 와인', learning_goal: '비교하기' };
    const preview = await json(`/api/admin/prompts/RECOMMEND/preview`, 'admin-token', { method: 'POST', body: JSON.stringify({ version_id: draftId, input }) });
    const draft = await promptRepository.getPromptVersion('RECOMMEND', draftId);
    expect(preview.response.status).toBe(200);
    expect(preview.body.messages).toEqual(buildRuntimePromptMessages('RECOMMEND', draft!, {
      original_request: input.original_request, refinement_request: input.refinement_request,
      previous_suggestions: input.previous_titles.map(title => ({ title })),
    }));
    expect((await json('/api/admin/prompts/RECOMMEND/audit-logs', 'admin-token')).body.audit_logs.some((item: any) => item.action === 'RESTORED')).toBe(true);
  });
});
