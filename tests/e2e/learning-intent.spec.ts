import { expect, test } from '@playwright/test';

for (const width of [1365, 390]) test('request purpose and refinement survive UI selection at width ' + width, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const examples = [
    ['초등학교 영어 단어 30개', '초등학교 영어 단어', 'apple', '사과'],
    ['재미있는 넌센스 퀴즈 30개', '재미있는 넌센스 퀴즈', '왕이 넘어지면?', '킹콩'],
    ['한국사 상식 문제 20개', '한국사 상식 문제', '조선을 건국한 사람은?', '이성계'],
    ['한자 20개', '한자', '山', '메 산'],
    ['영어 회화 문장 20개', '영어 회화 문장', 'How are you?', '어떻게 지내세요?'],
    ['영어 문법 빈칸 문제 20개', '영어 문법 빈칸 문제', 'I ___ to school yesterday. (go)', 'went'],
    ['경제 용어 30개', '경제 용어', '인플레이션', '물가의 지속적인 상승'],
    ['초등학생 과학 퀴즈 20개', '초등학생 과학 퀴즈', '물이 얼면 무엇이 되나요?', '얼음'],
  ];
  let current = examples[0];
  const refinement = '대상 수준을 유지하고 정답은 짧게';
  // Browser fixtures exercise transport/UI only; they do not evaluate a real model or variable counts.
  await page.route('**/api/ai/suggestions', route => route.fulfill({ json: {
    message: '요청하신 학습 방향을 선택하세요.',
    suggestions: [1, 2].map(index => ({ id: String(index), title: current[1] + (index === 1 ? '' : ' 복습'),
      description: '요청한 학습 형식 유지', learning_goal: '선택한 학습 내용을 익힌다' })),
    ai_usage_session_id: crypto.randomUUID(), ai_usage_session_token: 'local-test-only-token'.repeat(3),
  } }));
  await page.route('**/api/learning-sets', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({ json: { id: crypto.randomUUID(), title: current[1], original_request: current[0],
      status: 'COMPLETED', created_at: '2026-10-19T00:00:00Z', cards: Array.from({ length: 10 }, (_, index) => ({
        key: index === 0 ? current[2] : '화면 검증 항목 ' + index, values: [index === 0 ? current[3] : '화면 검증 값'],
      })) } });
  });
  for (const example of examples) {
    current = example;
    await page.goto('/');
    await expect(page.getByText("현재 AI 학습 콘텐츠는 요청한 개수와 관계없이 10장으로 생성·저장됩니다. 20장·30장 생성은 아직 지원하지 않습니다.", { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: '학습 주제 입력' }).fill(example[0]);
    await page.getByRole('button', { name: /AI에게 학습 주제 추천받기/ }).click();
    await expect(page.locator('.topic-card')).toHaveCount(2);
    await expect(page.getByText("현재 AI 학습 콘텐츠는 요청한 개수와 관계없이 10장으로 생성·저장됩니다. 20장·30장 생성은 아직 지원하지 않습니다.", { exact: true })).toBeVisible();
    await page.getByPlaceholder('예: 와인과 어울리는 음식에 대해 공부하고 싶어').fill(refinement);
    await page.getByRole('button', { name: '다시 추천' }).click();
    await expect(page.getByPlaceholder('예: 와인과 어울리는 음식에 대해 공부하고 싶어')).toHaveValue('');
    const outbound = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/learning-sets'));
    await page.locator('.topic-card').first().click();
    expect((await outbound).postDataJSON()).toMatchObject({ original_request: example[0], refinement_request: refinement,
      selected_topic: example[1], learning_goal: '선택한 학습 내용을 익힌다' });
    await expect(page.locator('.flashcard')).toContainText(example[2]);
    await expect(page.locator('.flashcard')).not.toContainText(example[3]);
    await page.locator('.flashcard').click();
    await expect(page.locator('.card-values')).toContainText(example[3]);
    await expect(page.getByRole('button', { name: '요청 프롬프트 확인' })).toHaveCount(0);
  }
});
