import type { AiUsageSummary, CreateSetRequest, Flashcard, Suggestion } from '../../../shared/schemas/index';

export interface RequestPromptMessage { role: 'system' | 'developer' | 'user'; content: string }

export type SourceMode = 'AI' | 'PHOTO' | 'TEXT' | 'EXCEL';
export interface ContentSet {
  id: string; title: string; original_request: string; selected_topic?: string; learning_goal?: string;
  created_at: string; updated_at?: string; status?: string; source_mode?: SourceMode;
  cards?: Flashcard[]; saved?: boolean; can_edit?: boolean; ai_usage_session_id?: string; ai_usage_session_token?: string;
}
export interface ContentListItem extends Omit<ContentSet, 'ai_usage_session_id'> {
  card_count: number; preview: Flashcard[]; can_edit: boolean; ai_usage?: AiUsageSummary | null;
}
export interface ContentListResponse {
  results: ContentListItem[]; total: number; page: number; page_size: number; total_pages: number;
}
export interface ImportPreview {
  cards: Flashcard[]; issues: { row: number; message: string }[];
}
export type AdminPromptKey = 'RECOMMEND' | 'FLASHCARD';
export type AdminPromptVersion = { id: string; template_id: string; version_number: number; system_prompt: string; developer_prompt: string;
  user_template: string; status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'; change_note: string | null; created_at: string; activated_at: string | null };
export type AdminPromptTemplate = { id: string; prompt_key: AdminPromptKey; name: string; description: string; is_enabled: boolean; created_at: string; versions: AdminPromptVersion[] };
export type AdminPromptAudit = { id: string; template_id: string; version_id: string | null; action: string; change_summary: string; created_at: string };
let tokenProvider: () => string | null = () => null;
export function setAccessTokenProvider(provider: () => string | null) { tokenProvider = provider; }
async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const hasJson = init.body !== undefined && typeof init.body === 'string';
  if (hasJson && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const token = tokenProvider();
  if (token) headers.set('authorization', 'Bearer ' + token);
  const response = await fetch(url, { ...init, headers });
  if (response.status === 204) return undefined as T;
  const isJson = response.headers.get('content-type')?.includes('application/json');
  const body = isJson ? await response.json() : await response.text();
  if (!response.ok) throw new Error(typeof body === 'object' && body?.error ? body.error : '요청을 처리하지 못했습니다.');
  return body as T;
}
export const api = {
  search: (q: string) => request<{ results: ContentSet[] }>('/api/learning-sets/search?q=' + encodeURIComponent(q)),
  list: (input: { q: string; sort: 'newest' | 'name'; page: number; page_size: number; scope: 'all' | 'mine' }) => {
    const params = new URLSearchParams({ ...input, page: String(input.page), page_size: String(input.page_size) });
    return request<ContentListResponse>('/api/learning-sets?' + params);
  },
  suggestions: (body: { original_request: string; refinement_request: string; previous_suggestions: Suggestion[]; ai_usage_session_id?: string; ai_usage_session_token?: string }) =>
    request<{ message: string; suggestions: Suggestion[]; ai_usage_session_id: string; ai_usage_session_token: string }>('/api/ai/suggestions', { method: 'POST', body: JSON.stringify(body) }),
  create: (body: CreateSetRequest) => request<ContentSet>('/api/learning-sets', { method: 'POST', body: JSON.stringify(body) }),
  get: (id: string) => request<ContentSet>('/api/learning-sets/' + encodeURIComponent(id)),
  createImported: (body: { title: string; cards: Flashcard[]; source_mode: SourceMode; ai_usage_session_id?: string; ai_usage_session_token?: string }) =>
    request<ContentSet>('/api/learning-sets/import', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: { title: string; cards: Flashcard[]; source_mode: SourceMode; expected_updated_at: string }) =>
    request<ContentSet>('/api/learning-sets/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(body) }),
  delete: (id: string) => request<void>('/api/learning-sets/' + encodeURIComponent(id), { method: 'DELETE' }),
  importPreview: (id: string, body: { title: string; cards: Flashcard[]; source_mode: SourceMode }) =>
    request<{ current: { title: string; cards: Flashcard[]; updated_at: string }; proposed: typeof body; changes: { before: number; after: number } }>(
      '/api/learning-sets/' + encodeURIComponent(id) + '/import-preview', { method: 'POST', body: JSON.stringify(body) }),
  parseText: (text: string) => request<ImportPreview>('/api/import/text/parse', { method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: text }),
  inspectExcel: (file: File) => request<{ sheets: { name: string; columns: { index: number; name: string }[]; preview: string[][] }[] }>(
    '/api/import/excel/inspect', { method: 'POST', headers: { 'content-type': file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, body: file }),
  parseExcel: (file: File, sheet: string, keyColumn?: number, valueColumns?: number[]) => request<ImportPreview>(
    '/api/import/excel/parse', { method: 'POST', headers: {
      'content-type': file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'x-sheet-name': sheet,
      ...(keyColumn ? { 'x-key-column': String(keyColumn) } : {}),
      ...(valueColumns ? { 'x-value-columns': valueColumns.join(',') } : {}),
    }, body: file }),
  extractPhoto: (file: File) => request<{ cards: Flashcard[]; review_card_indexes: number[]; ai_usage_session_id: string; ai_usage_session_token: string }>('/api/import/photo', {
    method: 'POST', headers: { 'content-type': file.type }, body: file }),
  adminAccess: () => request<{ is_admin: boolean }>('/api/admin/access'),
  adminPrompts: () => request<{ prompts: AdminPromptTemplate[] }>('/api/admin/prompts'),
  adminPromptVersions: (key: AdminPromptKey) => request<{ versions: AdminPromptVersion[] }>(`/api/admin/prompts/${key}/versions`),
  adminCreateDraft: (key: AdminPromptKey, change_note: string) => request<{ version: AdminPromptVersion }>(`/api/admin/prompts/${key}/drafts`, { method: 'POST', body: JSON.stringify({ change_note }) }),
  adminUpdateDraft: (key: AdminPromptKey, id: string, value: { system_prompt: string; developer_prompt: string; user_template: string; change_note: string }) =>
    request<{ version: AdminPromptVersion }>(`/api/admin/prompts/${key}/drafts/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(value) }),
  adminValidateDraft: (key: AdminPromptKey, id: string, value: { system_prompt: string; developer_prompt: string; user_template: string }) =>
    request<{ valid: boolean; errors: string[] }>(`/api/admin/prompts/${key}/drafts/${encodeURIComponent(id)}/validate`, { method: 'POST', body: JSON.stringify(value) }),
  adminActivate: (key: AdminPromptKey, id: string, expected_active_version_id: string) => request<{ version: AdminPromptVersion }>(
    `/api/admin/prompts/${key}/versions/${encodeURIComponent(id)}/activate`, { method: 'POST', body: JSON.stringify({ expected_active_version_id }) }),
  adminRestore: (key: AdminPromptKey, id: string, change_note: string) => request<{ version: AdminPromptVersion }>(
    `/api/admin/prompts/${key}/versions/${encodeURIComponent(id)}/restore`, { method: 'POST', body: JSON.stringify({ change_note }) }),
  adminAudit: (key: AdminPromptKey) => request<{ audit_logs: AdminPromptAudit[] }>(`/api/admin/prompts/${key}/audit-logs`),
  adminPreview: (key: AdminPromptKey, version_id: string, input: { original_request: string; refinement_request: string;
    previous_titles: string[]; selected_topic: string; learning_goal: string }) => request<{ prompt_key: AdminPromptKey; version_id: string | null; version_number: number | null; fallback: boolean; messages: RequestPromptMessage[] }>(
      `/api/admin/prompts/${key}/preview`, { method: 'POST', body: JSON.stringify({ version_id, input }) }),
  download: async (id: string, format: 'txt' | 'xlsx') => {
    const headers = new Headers();
    const token = tokenProvider(); if (token) headers.set('authorization', 'Bearer ' + token);
    const response = await fetch('/api/learning-sets/' + encodeURIComponent(id) + '/export?format=' + format, { headers });
    if (!response.ok) throw new Error('파일을 내려받지 못했습니다.');
    return response.blob();
  },
};
