import type { ActivePrompt, PromptKey, PromptTemplate } from './templates.js';

export type PromptStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export interface PromptVersion extends PromptTemplate {
  id: string; template_id: string; version_number: number; status: PromptStatus; change_note: string | null;
  created_by: string | null; created_at: string; activated_by: string | null; activated_at: string | null;
}
export interface PromptTemplateRecord {
  id: string; prompt_key: PromptKey; name: string; description: string; is_enabled: boolean; created_at: string;
  versions?: PromptVersion[];
}
export interface PromptAuditRecord {
  id: string; template_id: string; version_id: string | null; action: string; actor_user_id: string | null;
  change_summary: string; created_at: string;
}

export interface PromptRepository {
  loadActivePrompt(key: PromptKey): Promise<ActivePrompt | null>;
  listPromptTemplates(): Promise<PromptTemplateRecord[]>;
  listPromptVersions(key: PromptKey): Promise<PromptVersion[]>;
  getPromptVersion(key: PromptKey, versionId: string): Promise<PromptVersion | null>;
  createPromptDraft(key: PromptKey, actorId: string, note: string): Promise<PromptVersion>;
  updatePromptDraft(key: PromptKey, versionId: string, actorId: string, value: PromptTemplate, note: string): Promise<PromptVersion>;
  activatePromptVersion(key: PromptKey, versionId: string, actorId: string, expectedActiveVersionId: string): Promise<PromptVersion>;
  restorePromptVersion(key: PromptKey, sourceVersionId: string, actorId: string, note: string): Promise<PromptVersion>;
  listPromptAudit(key: PromptKey, limit: number): Promise<PromptAuditRecord[]>;
}

export function isPromptKey(value: unknown): value is PromptKey { return value === 'RECOMMEND' || value === 'FLASHCARD'; }
