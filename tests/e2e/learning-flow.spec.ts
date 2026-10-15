import { expect, test } from '@playwright/test';

test('search existing content and complete a mocked learning flow', async ({ page, request }) => {
  const seed = await request.post('/api/learning-sets', { data: {
    original_request: '와인', selected_topic: '와인 기초 지식', learning_goal: '와인의 기본 개념을 이해한다',
    client_request_id: crypto.randomUUID(),
  } });
  expect(seed.status()).toBe(201);
  await page.goto('/');
  await page.getByRole('textbox', { name: '학습 주제 입력' }).fill('와');
  await expect(page.getByRole('listbox', { name: '기존 학습 콘텐츠' })).toContainText('와인 기초 지식');
  await page.getByRole('textbox', { name: '학습 주제 입력' }).fill('와인');
  await page.getByRole('button', { name: /AI에게 학습 주제 추천받기/ }).click();
  await expect(page.getByRole('heading', { name: /와인에 대해 어떤 내용을 학습하고 싶으세요/ })).toBeVisible();
  await expect(page.locator('.topic-card')).toHaveCount(3);
  await page.getByRole('textbox', { name: /예: 와인과 어울리는 음식/ }).fill('와인 음식 페어링');
  await page.getByRole('button', { name: '다시 추천' }).click();
  await expect(page.getByRole('heading', { name: /와인 음식 페어링에 대해/ })).toBeVisible();
  await page.locator('.topic-card').first().click();
  await expect(page.getByRole('heading', { name: /와인 음식 페어링 핵심 개념/ })).toBeVisible();
  await expect(page.locator('.flashcard')).toBeVisible();
  await page.locator('.flashcard').click();
  await expect(page.locator('.card-values')).toBeVisible();
  await page.getByRole('button', { name: '다음 카드 →' }).click();
  await expect(page.locator('.study-controls')).toContainText('2 / 10');
  for (let i = 2; i <= 10; i++) {
    await page.locator('.study-controls button').last().click();
  }
  await expect(page.getByText('학습을 마쳤어요!')).toBeVisible();
  await page.getByRole('button', { name: '새 주제 학습하기' }).click();
  await page.getByRole('textbox', { name: '학습 주제 입력' }).fill('와');
  await page.getByRole('button', { name: /와인 기초 지식/ }).click();
  await expect(page.getByRole('heading', { name: '와인 기초 지식' })).toBeVisible();
  await page.getByRole('button', { name: '← 다른 주제 학습하기' }).click();
  await page.getByRole('textbox', { name: '학습 주제 입력' }).fill('피아노');
  await page.getByRole('button', { name: /AI에게 학습 주제 추천받기/ }).click();
  await expect(page.getByRole('heading', { name: /피아노에 대해 어떤 내용을 학습하고 싶으세요/ })).toBeVisible();
});
