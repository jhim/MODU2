import { z } from 'zod';
import type { SuggestionPromptMessage } from './index.js';

export type PromptKey = 'RECOMMEND' | 'FLASHCARD';
export type PromptTemplate = { system_prompt: string; developer_prompt: string; user_template: string };
export type PromptVariables = Record<string, string>;

const requiredVariables: Record<PromptKey, string[]> = {
  RECOMMEND: ['original_request_json', 'refinement_request_json', 'previous_titles_json'],
  FLASHCARD: ['original_request_json', 'selected_topic_json', 'learning_goal_json'],
};
const optionalVariables: Record<PromptKey, string[]> = { RECOMMEND: [], FLASHCARD: ['refinement_request_json'] };
const promptInputSchema = z.object({
  system_prompt: z.string().trim().min(1).max(20_000),
  developer_prompt: z.string().trim().min(1).max(40_000),
  user_template: z.string().trim().min(1).max(20_000),
});

export function validatePromptTemplate(promptKey: PromptKey, value: unknown) {
  const parsed = promptInputSchema.safeParse(value);
  if (!parsed.success) return { valid: false, errors: parsed.error.issues.map(issue => `${issue.path.join('.') || 'prompt'}: ${issue.message}`) };
  const found = [...parsed.data.user_template.matchAll(/{{\s*([a-zA-Z0-9_]+)\s*}}/g)].map(match => match[1]);
  const stripped = parsed.data.user_template.replace(/{{\s*[a-zA-Z0-9_]+\s*}}/g, '');
  const errors: string[] = [];
  if (/{{|}}/.test(stripped)) errors.push('User 템플릿에 닫히지 않았거나 잘못된 변수가 있습니다.');
  for (const name of found) if (![...requiredVariables[promptKey], ...optionalVariables[promptKey]].includes(name)) errors.push(`지원하지 않는 변수: {{${name}}}`);
  for (const name of requiredVariables[promptKey]) if (!found.includes(name)) errors.push(`필수 변수가 없습니다: {{${name}}}`);
  if (errors.length) return { valid: false, errors };
  return { valid: true, errors: [] as string[], value: parsed.data };
}

export function renderUserTemplate(template: string, variables: PromptVariables): string {
  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, name: string) => variables[name] ?? 'null');
}

export type ActivePrompt = PromptTemplate & { id: string; version_number: number };

export function buildManagedSuggestionMessages(input: { original_request: string; refinement_request: string; previous_suggestions: unknown[] }, prompt: PromptTemplate): SuggestionPromptMessage[] {
  const variables = {
    original_request_json: JSON.stringify(input.original_request),
    refinement_request_json: JSON.stringify(input.refinement_request),
    previous_titles_json: JSON.stringify(input.previous_suggestions.slice(-6).map((item: any) => typeof item?.title === 'string' ? item.title : '').filter(Boolean)),
  };
  return [
    { role: 'system', content: prompt.system_prompt },
    { role: 'developer', content: prompt.developer_prompt },
    { role: 'user', content: renderUserTemplate(prompt.user_template, variables) },
  ];
}

export function buildManagedFlashcardMessages(input: { original_request: string; refinement_request?: string; selected_topic: string; learning_goal: string }, prompt: PromptTemplate): SuggestionPromptMessage[] {
  const variables = {
    original_request_json: JSON.stringify(input.original_request),
    refinement_request_json: JSON.stringify(input.refinement_request ?? ''),
    selected_topic_json: JSON.stringify(input.selected_topic),
    learning_goal_json: JSON.stringify(input.learning_goal),
  };
  let userContent = renderUserTemplate(prompt.user_template, variables);
  if (input.refinement_request && !/{{\s*refinement_request_json\s*}}/.test(prompt.user_template)) {
    userContent += '\n\n추가 학습 조건(JSON 데이터): ' + JSON.stringify({ refinement_request: input.refinement_request });
  }
  return [
    { role: 'system', content: prompt.system_prompt },
    { role: 'developer', content: prompt.developer_prompt },
    { role: 'user', content: userContent },
  ];
}
