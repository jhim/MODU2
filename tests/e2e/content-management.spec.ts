import { expect, test } from '@playwright/test';

test('opens the paginated library and previews imported text before login-gated saving', async ({ page, request }) => {
  const seed = await request.post('/api/learning-sets', { data: {
    original_request: '차', selected_topic: '차 기초', learning_goal: '차의 기본 개념을 이해한다',
    client_request_id: crypto.randomUUID(),
  } });
  expect(seed.status()).toBe(201);
  await page.goto('/');
  await page.getByRole('button', { name: '학습 콘텐츠 목록' }).click();
  await expect(page.getByRole('heading', { name: '학습 콘텐츠 목록' })).toBeVisible();
  const row = page.locator('.content-row').filter({ hasText: '차 기초' });
  await expect(row).toContainText('차 기초');
  await expect(row).toContainText('10개 카드');
  const download = page.waitForEvent('download');
  await row.getByRole('button', { name: 'Excel', exact: true }).click();
  expect((await download).suggestedFilename()).toContain('.xlsx');

  await page.getByRole('button', { name: '만들기', exact: true }).click();
  await page.getByRole('button', { name: '사진 · TXT · Excel · 붙여넣기' }).click();
  await page.getByRole('textbox', { name: /또는 텍스트 붙여넣기/ }).fill('key_text\tvalue_1\tvalue_2\napple\t사과\t과일\nbook\t책\t도서');
  await page.getByRole('textbox', { name: '콘텐츠 제목' }).fill('과일과 책');
  await page.getByRole('button', { name: '카드 미리보기' }).click();
  await expect(page.getByRole('heading', { name: '새 학습 콘텐츠' })).toBeVisible();
  await expect(page.locator('.card-editor')).toHaveCount(2);
  await expect(page.locator('.card-editor').first().getByPlaceholder('질문 또는 용어')).toHaveValue('apple');
  await page.getByRole('button', { name: '변경 사항 저장' }).click();
  await expect(page.getByRole('heading', { name: '로그인' })).toBeVisible();
  await expect(page.getByText(/Supabase Auth 환경변수를 설정/)).toBeVisible();
});
