import { logMetric } from '../lib/metrics.js';
import { DEFAULT_PROMPT_TEMPLATES, buildFlashcardPromptMessages, buildSuggestionPromptMessages } from './index.js';
import type { PromptRepository, PromptVersion } from './repository.js';
import { validatePromptTemplate, type ActivePrompt, type PromptKey, type PromptTemplate } from './templates.js';

export type PromptRuntimeSnapshot = { prompt: PromptTemplate; versionId?: string; versionNumber?: number; fallback: boolean };

export async function loadRuntimePrompt(store: Pick<PromptRepository, 'loadActivePrompt'> | undefined, key: PromptKey, requestId: string): Promise<PromptRuntimeSnapshot> {
  if (!store) {
    logMetric('ai_prompt_fallback', { request_id: requestId, prompt_key: key, reason: 'prompt_store_unavailable' });
    return { prompt: DEFAULT_PROMPT_TEMPLATES[key], fallback: true };
  }
  try {
    const active = await store.loadActivePrompt(key);
    if (!active) {
      logMetric('ai_prompt_fallback', { request_id: requestId, prompt_key: key, reason: 'active_prompt_missing' });
      return { prompt: DEFAULT_PROMPT_TEMPLATES[key], fallback: true };
    }
    const validation = validatePromptTemplate(key, active);
    if (!validation.valid) {
      logMetric('ai_prompt_fallback', { request_id: requestId, prompt_key: key, reason: 'active_prompt_invalid' });
      return { prompt: DEFAULT_PROMPT_TEMPLATES[key], fallback: true };
    }
    return { prompt: validation.value!, versionId: active.id, versionNumber: active.version_number, fallback: false };
  } catch (error) {
    logMetric('ai_prompt_fallback', { request_id: requestId, prompt_key: key,
      reason: error instanceof Error ? error.name : 'unknown' });
    return { prompt: DEFAULT_PROMPT_TEMPLATES[key], fallback: true };
  }
}

export function buildRuntimePromptMessages(key: PromptKey, prompt: PromptTemplate, input: any) {
  return key === 'RECOMMEND' ? buildSuggestionPromptMessages(input, prompt) : buildFlashcardPromptMessages(input, prompt);
}

export function promptVersionTemplate(version: PromptVersion | ActivePrompt): PromptTemplate {
  return { system_prompt: version.system_prompt, developer_prompt: version.developer_prompt, user_template: version.user_template };
}
