import { describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { buildFlashcardPromptMessages, buildSuggestionPromptMessages, DEFAULT_PROMPT_TEMPLATES } from '../../server/src/prompts/index.js';
import { MemoryPromptRepository } from '../../server/src/prompts/memory-repository.js';
import { validatePromptTemplate } from '../../server/src/prompts/templates.js';
import { OpenAiService } from '../../server/src/services/ai.js';

describe('managed prompt templates', () => {
  it('keeps the existing role structure and JSON user payload while substituting data as JSON literals', () => {
    const input = { original_request: 'topic "quoted" \\ payload', refinement_request: '', previous_suggestions: [{ title: 'prior' }] };
    const fallbackMessages = buildSuggestionPromptMessages(input);
    expect(fallbackMessages.map(message => message.role)).toEqual(['system', 'developer', 'user']);
    expect(JSON.parse(fallbackMessages[2].content)).toEqual({ original_request: input.original_request, refinement_request: '', previous_titles: ['prior'] });

    const cardMessages = buildFlashcardPromptMessages({ original_request: '한자', selected_topic: '學', learning_goal: '뜻을 익힌다' });
    expect(cardMessages.map(message => message.role)).toEqual(['system', 'developer', 'user']);
    expect(JSON.parse(cardMessages[2].content)).toMatchObject({ original_request: '한자', selected_topic: '學', card_count: 10 });
  });

  it('requires all supported placeholders and rejects unknown or malformed variables', () => {
    expect(validatePromptTemplate('RECOMMEND', DEFAULT_PROMPT_TEMPLATES.RECOMMEND).valid).toBe(true);
    expect(validatePromptTemplate('RECOMMEND', { ...DEFAULT_PROMPT_TEMPLATES.RECOMMEND, user_template: '{{unknown}}' })).toMatchObject({ valid: false });
    expect(validatePromptTemplate('FLASHCARD', { ...DEFAULT_PROMPT_TEMPLATES.FLASHCARD, user_template: '{{original_request_json' })).toMatchObject({ valid: false });
  });

  it('copies the exact ACTIVE prompt into a mock draft and clearly rejects a missing ACTIVE version', async () => {
    const prompts = new MemoryPromptRepository();
    const initial = await prompts.loadActivePrompt('RECOMMEND');
    const draft = await prompts.createPromptDraft('RECOMMEND', 'admin-user', 'copy original');
    const edited = { system_prompt: 'custom active system', developer_prompt: 'custom active developer',
      user_template: DEFAULT_PROMPT_TEMPLATES.RECOMMEND.user_template };
    await prompts.updatePromptDraft('RECOMMEND', draft.id, 'admin-user', edited, 'edit');
    await prompts.activatePromptVersion('RECOMMEND', draft.id, 'admin-user', initial!.id);
    const nextDraft = await prompts.createPromptDraft('RECOMMEND', 'admin-user', 'copy active');
    expect(nextDraft).toMatchObject({ ...edited, status: 'DRAFT' });

    const internals = prompts as unknown as { versions: Map<string, { status: string }[]> };
    internals.versions.get('FLASHCARD')![0]!.status = 'ARCHIVED';
    await expect(prompts.createPromptDraft('FLASHCARD', 'admin-user', 'no active')).rejects.toThrow('active prompt version is missing');
  });

  it('uses one active-version snapshot for the actual OpenAI request without returning prompt text', async () => {
    const prompts = new MemoryPromptRepository();
    const active = await prompts.loadActivePrompt('RECOMMEND');
    const draft = await prompts.createPromptDraft('RECOMMEND', 'admin-user', 'dynamic prompt test');
    await prompts.updatePromptDraft('RECOMMEND', draft.id, 'admin-user', { system_prompt: 'active database system',
      developer_prompt: 'active database developer', user_template: DEFAULT_PROMPT_TEMPLATES.RECOMMEND.user_template }, 'dynamic prompt test');
    await prompts.activatePromptVersion('RECOMMEND', draft.id, 'admin-user', active!.id);
    let outbound: any;
    const client = new OpenAI({ apiKey: 'local-test-only', maxRetries: 0, fetch: async (_url, init) => {
      outbound = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: 'managed-prompt-completion', object: 'chat.completion', created: 1, model: 'gpt-4o-mini',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ message: '주제를 고르세요.', suggestions: [
          { id: 'a', title: '범위 하나', description: '소개', learning_goal: '이해한다' },
          { id: 'b', title: '범위 둘', description: '소개', learning_goal: '비교한다' },
        ] }) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    } });
    const result = await new OpenAiService('local-test-only', 'gpt-4o-mini', client, prompts).suggest({
      original_request: '열대 우림 포유류', refinement_request: '', previous_suggestions: [],
    }, 'test-request');
    expect(result).not.toHaveProperty('requestPrompt');
    expect(outbound.messages.map((message: { role: string }) => message.role)).toEqual(['system', 'developer', 'user']);
    expect(outbound.messages[0].content).toBe('active database system');
    expect(outbound.messages[1].content).toBe('active database developer');
    expect(result.data.suggestions).toHaveLength(2);
  });

  it('falls back to code prompts when active prompt storage is unavailable', async () => {
    const failingStore = { loadActivePrompt: async () => { throw new Error('table missing'); } };
    let outbound: any;
    const client = new OpenAI({ apiKey: 'local-test-only', maxRetries: 0, fetch: async (_url, init) => {
      outbound = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: 'fallback-completion', object: 'chat.completion', created: 1, model: 'gpt-4o-mini',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ message: '주제를 고르세요.', suggestions: [
          { id: 'a', title: '하나', description: '소개', learning_goal: '이해한다' },
          { id: 'b', title: '둘', description: '소개', learning_goal: '비교한다' },
        ] }) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    } });
    const result = await new OpenAiService('local-test-only', 'gpt-4o-mini', client, failingStore as any).suggest({
      original_request: 'topic', refinement_request: '', previous_suggestions: [],
    }, 'fallback-request');
    expect(result).not.toHaveProperty('requestPrompt');
    expect(outbound.messages.map((message: { role: string }) => message.role)).toEqual(['system', 'developer', 'user']);
    expect(outbound.messages[0].content).toBe(DEFAULT_PROMPT_TEMPLATES.RECOMMEND.system_prompt);
  });
});
