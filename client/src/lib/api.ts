import type { CreateSetRequest, Flashcard, Suggestion } from '../../../shared/schemas/index';

export interface ContentSet { id: string; title: string; original_request: string; created_at: string; cards?: Flashcard[] }
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '요청을 처리하지 못했습니다.');
  return body as T;
}
export const api = {
  search: (q: string) => request<{ results: ContentSet[] }>(`/api/learning-sets/search?q=${encodeURIComponent(q)}`),
  suggestions: (body: { original_request: string; refinement_request: string; previous_suggestions: Suggestion[] }) =>
    request<{ message: string; suggestions: Suggestion[] }>('/api/ai/suggestions', { method: 'POST', body: JSON.stringify(body) }),
  create: (body: CreateSetRequest) => request<ContentSet>('/api/learning-sets', { method: 'POST', body: JSON.stringify(body) }),
  get: (id: string) => request<ContentSet>(`/api/learning-sets/${id}`),
};
