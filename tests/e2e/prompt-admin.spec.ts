import { expect, test } from '@playwright/test';

test('admin can create a prompt draft and preview messages without calling OpenAI', async ({ page }) => {
  const active = { id: '00000000-0000-4000-8000-000000000001', template_id: '00000000-0000-4000-8000-000000000010',
    version_number: 1, system_prompt: '운영 System', developer_prompt: '운영 Developer',
    user_template: '{"original_request": {{original_request_json}}, "refinement_request": {{refinement_request_json}}, "previous_titles": {{previous_titles_json}}}',
    status: 'ACTIVE', change_note: '기본 버전', created_by: null, created_at: '2026-10-15T00:00:00Z', activated_by: 'system', activated_at: '2026-10-15T00:00:00Z' };
  const draft = { ...active, id: '00000000-0000-4000-8000-000000000002', version_number: 2, status: 'DRAFT', change_note: '테스트 초안', activated_by: null, activated_at: null };
  let promptCalls = 0;
  let hasDraft = false;
  await page.route('**/api/admin/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    let body: unknown = {};
    if (path === '/api/admin/access') body = { is_admin: true };
    else if (path === '/api/admin/prompts' || path.endsWith('/versions')) body = { prompts: [
      { id: active.template_id, prompt_key: 'RECOMMEND', name: '학습 주제 추천', description: '', is_enabled: true, created_at: active.created_at, versions: hasDraft ? [draft, active] : [active] },
      { id: active.template_id, prompt_key: 'FLASHCARD', name: '플래시카드 생성', description: '', is_enabled: true, created_at: active.created_at, versions: [active] },
    ], versions: [active] };
    else if (path.endsWith('/audit-logs')) body = { audit_logs: [] };
    else if (path.endsWith('/drafts') && request.method() === 'POST') { hasDraft = true; body = { version: draft }; }
    else if (path.endsWith('/validate')) body = { valid: true, errors: [] };
    else if (path.endsWith('/preview')) body = { prompt_key: 'RECOMMEND', version_id: draft.id, version_number: 2, fallback: false,
      messages: [{ role: 'system', content: '미리보기 System' }, { role: 'developer', content: '미리보기 Developer' },
        { role: 'user', content: '{"original_request":"열대 우림 포유류","refinement_request":"","previous_titles":[]}' }] };
    else if (path.includes('/drafts/') && request.method() === 'PUT') body = { version: { ...draft, ...request.postDataJSON() } };
    else body = { version: draft };
    if (path.endsWith('/preview')) promptCalls++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await page.getByLabel('이메일').fill('test@example.com');
  await page.getByLabel('비밀번호').fill('password123');
  await page.locator('.auth-panel').getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page.getByRole('button', { name: 'AI 프롬프트 관리' })).toBeVisible();
  await page.getByRole('button', { name: 'AI 프롬프트 관리' }).click();
  await expect(page.getByRole('heading', { name: 'AI 프롬프트 관리' })).toBeVisible();
  await page.getByRole('button', { name: '새 초안' }).click();
  await expect(page.getByRole('heading', { name: 'v2 초안' })).toBeVisible();
  await page.getByRole('button', { name: '미리보기 만들기' }).click();
  await expect(page.getByText('미리보기 System')).toBeVisible();
  await expect(page.getByText('미리보기 Developer')).toBeVisible();
  await expect(page.getByText(/열대 우림 포유류/)).toBeVisible();
  expect(promptCalls).toBe(1);
});

test('regular signed-in users see neither prompt management nor a prompt preview popup', async ({ page }) => {
  await page.route('**/api/admin/access', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"is_admin":false}' }));
  await page.route('**/api/ai/suggestions', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    message: '와인에 대해 어떤 내용을 학습하고 싶으세요?',
    suggestions: [{ id: 'one', title: '와인의 역사', description: '기원과 발전', learning_goal: '역사를 설명한다' },
      { id: 'two', title: '와인의 종류', description: '종류와 특징', learning_goal: '차이를 구분한다' }],
    ai_usage_session_id: 'session-id', ai_usage_session_token: 'session-token',
  }) }));
  await page.goto('/');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await page.getByLabel('이메일').fill('test@example.com');
  await page.getByLabel('비밀번호').fill('password123');
  await page.locator('.auth-panel').getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page.getByRole('button', { name: 'AI 프롬프트 관리' })).toHaveCount(0);
  await page.getByRole('textbox', { name: '학습 주제 입력' }).fill('와인');
  await page.getByRole('button', { name: /AI에게 학습 주제 추천받기/ }).click();
  await expect(page.getByRole('button', { name: '와인의 역사' })).toBeVisible();
  await expect(page.getByRole('button', { name: '요청 프롬프트 확인' })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
