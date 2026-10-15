import { expect, test } from '@playwright/test';

test('home examples show concrete topics and pass the complete selected scope to recommendations', async ({ page }) => {
  const topics = ['와인의 역사', '악보의 기본 구성 요소', '17세기 세계사', '초등학교 4학년 영어 단어'];
  await page.goto('/');
  const input = page.getByRole('textbox', { name: '학습 주제 입력' });
  await expect(input).toHaveAttribute('placeholder', '예: 와인의 역사, 악보의 기본 구성 요소, 17세기 세계사');
  const sampleButtons = page.locator('.topic-samples button');
  await expect(sampleButtons).toHaveText(topics);

  for (const topic of topics) {
    await page.getByRole('button', { name: topic, exact: true }).click();
    await expect(input).toHaveValue(topic);
    const suggestionRequest = page.waitForRequest(request => request.url().endsWith('/api/ai/suggestions'));
    await page.getByRole('button', { name: /AI에게 학습 주제 추천받기/ }).click();
    const request = await suggestionRequest;
    expect(request.postDataJSON().original_request).toBe(topic);
    await expect(page.getByRole('heading', { name: new RegExp(topic) })).toBeVisible();
    await page.getByRole('button', { name: '← 처음으로' }).click();
  }

  await page.setViewportSize({ width: 320, height: 700 });
  const buttonBounds = await sampleButtons.evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
  }));
  expect(buttonBounds).toHaveLength(4);
  for (const bounds of buttonBounds) {
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(320);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth + 1);
  }
});

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
  await expect(page.locator('.topic-card')).toContainText(['와인의 역사', '와인의 종류와 특징', '와인 라벨 읽는 방법']);
  await page.getByRole('button', { name: '요청 프롬프트 확인' }).click();
  const promptDialog = page.getByRole('dialog', { name: 'AI 요청 프롬프트' });
  await expect(promptDialog).toContainText('System');
  await expect(promptDialog).toContainText('Developer');
  await expect(promptDialog).toContainText('User');
  await expect(promptDialog).toContainText('"original_request":"와인"');
  await expect(promptDialog).not.toContainText('ai_usage_session_token');
  const desktopPromptBox = await promptDialog.boundingBox();
  expect(desktopPromptBox).not.toBeNull();
  expect(desktopPromptBox!.x + desktopPromptBox!.width).toBeLessThanOrEqual(1280);
  await page.setViewportSize({ width: 390, height: 844 });
  const mobilePromptBox = await promptDialog.boundingBox();
  expect(mobilePromptBox).not.toBeNull();
  expect(mobilePromptBox!.x).toBeGreaterThanOrEqual(0);
  expect(mobilePromptBox!.x + mobilePromptBox!.width).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: '닫기' }).click();
  await expect(promptDialog).toBeHidden();
  await page.getByRole('textbox', { name: /예: 와인과 어울리는 음식/ }).fill('와인 음식 페어링');
  await page.getByRole('button', { name: '다시 추천' }).click();
  await expect(page.getByRole('heading', { name: /와인 음식 페어링에 대해/ })).toBeVisible();
  await page.locator('.topic-card').first().click();
  await expect(page.getByRole('heading', { name: /와인 음식 페어링의 주요 용어와 원리/ })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: '학습 콘텐츠 목록' })).toBeVisible();
  const learnedSet = page.locator('.content-row').filter({ hasText: '와인 음식 페어링의 주요 용어와 원리' });
  await expect(learnedSet).toContainText('최초 검색어: 와인');
  await page.getByRole('button', { name: '만들기', exact: true }).click();
  await page.getByRole('textbox', { name: '학습 주제 입력' }).fill('피아노');
  await page.getByRole('button', { name: /AI에게 학습 주제 추천받기/ }).click();
  await expect(page.getByRole('heading', { name: /피아노에 대해 어떤 내용을 학습하고 싶으세요/ })).toBeVisible();
});

test('keeps a single visible topic-input focus ring on desktop and mobile', async ({ page }) => {
  await page.goto('/');
  const input = page.getByRole('textbox', { name: '학습 주제 입력' });
  for (const viewport of [{ width: 1365, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await input.click();
    await page.waitForTimeout(250);
    const focusStyles = await input.evaluate(element => ({
      focused: document.activeElement === element,
      wrapperHasFocus: element.closest('.search-box')!.matches(':focus-within'),
      outlineStyle: getComputedStyle(element).outlineStyle,
      inputShadow: getComputedStyle(element).boxShadow,
      wrapperShadow: getComputedStyle(element.closest('.search-box')!).boxShadow,
      wrapperBorder: getComputedStyle(element.closest('.search-box')!).borderColor,
    }));
    expect(focusStyles.focused).toBe(true);
    expect(focusStyles.wrapperHasFocus).toBe(true);
    expect(focusStyles.outlineStyle).toBe('none');
    expect(focusStyles.inputShadow).toBe('none');
    expect(focusStyles.wrapperShadow).toContain('0px 0px 0px 4px');
    expect(focusStyles.wrapperBorder).toBe('rgb(165, 154, 232)');
  }
});

test('shows recorded AI usage and leaves older content without usage blank', async ({ page }) => {
  const timestamp = '2026-10-15T00:00:00.000Z';
  await page.route(/\/api\/learning-sets\?/, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    results: [
      { id: crypto.randomUUID(), title: '사용량 기록 콘텐츠', original_request: '테스트', status: 'COMPLETED',
        created_at: timestamp, updated_at: timestamp, source_mode: 'AI', card_count: 10, preview: [], can_edit: false,
        ai_usage: { input_tokens: 1000, output_tokens: 250, total_tokens: 1250, cached_input_tokens: 0,
          estimated_usd: 0.0015, estimated_krw: 2.01, models: ['gpt-4o-mini'], operations: ['suggestions', 'flashcard_generation'],
          pricing_as_of: ['2026-10-15'], fx_rate_as_of: ['2026-10-13'], fx_rate_source: ['Federal Reserve H.10 / FRED DEXKOUS'],
          model_rates: [{ model: 'gpt-4o-mini', input_usd_per_million: 0.15, cached_input_usd_per_million: 0.075,
            output_usd_per_million: 0.6, pricing_as_of: '2026-10-15' }],
          fx_rates: [{ usd_krw_rate: 1342.13, as_of: '2026-10-13', source: 'Federal Reserve H.10 / FRED DEXKOUS' }] } },
      { id: crypto.randomUUID(), title: '기존 사용량 미기록 콘텐츠', original_request: '테스트', status: 'COMPLETED',
        created_at: timestamp, updated_at: timestamp, source_mode: 'AI', card_count: 10, preview: [], can_edit: false },
      { id: crypto.randomUUID(), title: 'null 사용량 콘텐츠', original_request: '  ', status: 'COMPLETED',
        created_at: timestamp, updated_at: timestamp, source_mode: 'AI', card_count: 10, preview: [], can_edit: false,
        ai_usage: { input_tokens: null, output_tokens: null, total_tokens: null, cached_input_tokens: null,
          estimated_usd: null, estimated_krw: null, models: null, operations: null, pricing_as_of: null,
          fx_rate_as_of: null, fx_rate_source: null, model_rates: null, fx_rates: null } },
    ], total: 2, page: 1, page_size: 20, total_pages: 1,
  }) }));
  await page.goto('/');
  await page.getByRole('button', { name: '학습 콘텐츠 목록' }).click();
  await expect(page.locator('.content-row')).toHaveCount(3);
  const recorded = page.locator('.content-row').filter({ hasText: '사용량 기록 콘텐츠' }).locator('.content-meta');
  const usageButton = recorded.getByRole('button', { name: '1,250 tokens · 약 2원' });
  await expect(usageButton).toBeVisible();
  await expect(recorded).not.toContainText('크레딧');
  const usageInfo = recorded.getByRole('tooltip');
  for (const viewport of [{ width: 1365, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await usageButton.click();
    await expect(usageInfo).toContainText('입력 1,000 · 출력 250 · 총 1,250 tokens');
    await expect(usageInfo).toContainText('예상 비용 $0.0015 · 약 2.01원');
    await expect(usageInfo).toContainText('gpt-4o-mini');
    await expect(usageInfo).toContainText('1342.13');
    await expect(usageInfo).toContainText('실제 청구액이 아닌 추정 API 비용');
    const infoBox = await usageInfo.boundingBox();
    expect(infoBox).not.toBeNull();
    expect(infoBox!.x).toBeGreaterThanOrEqual(0);
    expect(infoBox!.x + infoBox!.width).toBeLessThanOrEqual(viewport.width);
    if (viewport.width === 1365) {
      await page.getByRole('heading', { name: '학습 콘텐츠 목록' }).click();
      await expect(usageInfo).toBeHidden();
    } else {
      await usageButton.click();
      await expect(usageInfo).toBeHidden();
    }
  }
  const legacy = page.locator('.content-row').filter({ hasText: '기존 사용량 미기록 콘텐츠' }).locator('.content-meta');
  await expect(legacy).not.toContainText('크레딧');
  const nullUsage = page.locator('.content-row').filter({ hasText: 'null 사용량 콘텐츠' }).locator('.content-meta');
  await expect(nullUsage).not.toContainText('크레딧');
  await expect(page.locator('.content-row').filter({ hasText: 'null 사용량 콘텐츠' })).not.toContainText('최초 검색어');
});
