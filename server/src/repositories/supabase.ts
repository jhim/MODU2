import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ContentSource, LearningRepository, LearningSet, ContentListResult } from './types.js';
import type { Flashcard } from '../../../shared/schemas/index.js';
import type { AiUsageRecord } from '../services/ai-pricing.js';
import type { AiPromptUsage } from '../services/ai.js';
import type { ActivePrompt, PromptKey, PromptTemplate } from '../prompts/templates.js';
import type { PromptAuditRecord, PromptRepository, PromptTemplateRecord, PromptVersion } from '../prompts/repository.js';

export function toFlashcardRpcPayload(cards: Flashcard[]) {
  return cards.map((card, index) => ({ key_text: card.key, values: card.values, sort_order: index + 1 }));
}
function decodeContent(value: any): LearningSet {
  return { ...value, cards: Array.isArray(value?.cards) ? value.cards.map((card: any) =>
    ({ key: card.key ?? card.key_text, values: card.values })) : undefined } as LearningSet;
}
function one<T>(data: any): T {
  return (Array.isArray(data) ? data[0] : data) as T;
}
export class SupabaseLearningRepository implements LearningRepository, PromptRepository {
  private constructor(private readonly db: SupabaseClient) {}
  static fromEnv(url: string, key: string): SupabaseLearningRepository {
    return new SupabaseLearningRepository(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }));
  }
  async verifyAccessToken(token: string) {
    const { data, error } = await this.db.auth.getUser(token);
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email ?? undefined };
  }
  async search(query: string, limit: number): Promise<LearningSet[]> {
    const { data, error } = await this.db.rpc('search_completed_learning_sets', { p_query: query, p_limit: limit });
    if (error) throw error;
    return (data ?? []) as LearningSet[];
  }
  async reserve(input: { requestId: string; originalRequest: string; selectedTopic: string; learningGoal: string; ownerId?: string; aiUsageSessionId?: string }): Promise<{ set: LearningSet; created: boolean }> {
    const row = { client_request_id: input.requestId, title: input.selectedTopic, original_request: input.originalRequest,
      selected_topic: input.selectedTopic, learning_goal: input.learningGoal, status: 'GENERATING',
      ...(input.ownerId ? { owner_id: input.ownerId } : {}),
      ...(input.aiUsageSessionId ? { ai_usage_session_id: input.aiUsageSessionId } : {}) };
    const inserted = await this.db.from('learning_set').insert(row).select('id,title,original_request,selected_topic,learning_goal,status,created_at,updated_at,source_mode,owner_id,ai_usage_session_id').maybeSingle();
    if (!inserted.error && inserted.data) return { set: inserted.data as LearningSet, created: true };
    const existing = await this.db.from('learning_set').select('id,title,original_request,selected_topic,learning_goal,status,created_at,updated_at,source_mode,owner_id,ai_usage_session_id')
      .eq('client_request_id', input.requestId).maybeSingle();
    if (existing.error || !existing.data) throw inserted.error ?? existing.error;
    return { set: existing.data as LearningSet, created: false };
  }
  async complete(id: string, title: string, cards: Flashcard[]): Promise<LearningSet> {
    const { data, error } = await this.db.rpc('complete_learning_set', { p_learning_set_id: id, p_title: title, p_cards: toFlashcardRpcPayload(cards) });
    if (error) throw error;
    return { ...one<LearningSet>(data), cards };
  }
  async fail(id: string): Promise<void> {
    const { error } = await this.db.from('learning_set').update({ status: 'FAILED', updated_at: new Date().toISOString() })
      .eq('id', id).eq('status', 'GENERATING');
    if (error) throw error;
  }
  async getCompleted(id: string): Promise<LearningSet | null> {
    const { data, error } = await this.db.from('learning_set').select('id,title,original_request,selected_topic,learning_goal,status,created_at,updated_at,source_mode,owner_id,flashcard(key_text,values,sort_order)')
      .eq('id', id).eq('status', 'COMPLETED').maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const { flashcard, ...set } = data as any;
    return { ...set, cards: (flashcard ?? []).sort((a: any, b: any) => a.sort_order - b.sort_order)
      .map((card: any) => ({ key: card.key_text, values: card.values })) } as LearningSet;
  }
  async listContent(input: { query: string; sort: 'newest' | 'name'; page: number; pageSize: number; ownerId?: string; scope: 'all' | 'mine' }): Promise<ContentListResult> {
    const { data, error } = await this.db.rpc('list_learning_sets', {
      p_query: input.query, p_sort: input.sort, p_page: input.page, p_page_size: input.pageSize,
      p_owner_id: input.ownerId ?? null, p_scope: input.scope,
    });
    if (error) throw error;
    return data as ContentListResult;
  }
  async createOwned(input: { ownerId: string; title: string; cards: Flashcard[]; sourceMode: ContentSource; aiUsageSessionId?: string }): Promise<LearningSet> {
    const { data, error } = await this.db.rpc('create_owned_learning_set', {
      p_owner_id: input.ownerId, p_title: input.title, p_cards: input.cards, p_source_mode: input.sourceMode,
    });
    if (error) throw error;
    const set = decodeContent(one(data));
    if (input.aiUsageSessionId && (input.sourceMode === 'PHOTO' || input.sourceMode === 'AI')) {
      const attached = await this.db.rpc('attach_ai_usage_session', {
        p_learning_set_id: set.id, p_owner_id: input.ownerId, p_session_id: input.aiUsageSessionId,
      });
      if (attached.error) throw attached.error;
    }
    return set;
  }
  async recordAiUsage(input: { sessionId: string; requestId: string; operation: 'suggestions' | 'flashcard_generation' | 'image_extraction'; usage: AiUsageRecord; promptUsage?: AiPromptUsage; ownerId?: string }): Promise<void> {
    const usage = input.usage;
    const { error } = await this.db.rpc('record_ai_usage_event', {
      p_session_id: input.sessionId, p_request_id: input.requestId, p_operation: input.operation,
      p_model: usage.model, p_input_tokens: usage.inputTokens, p_output_tokens: usage.outputTokens,
      p_total_tokens: usage.totalTokens, p_cached_input_tokens: usage.cachedInputTokens,
      p_input_usd_per_million: usage.inputUsdPerMillion,
      p_cached_input_usd_per_million: usage.cachedInputUsdPerMillion,
      p_output_usd_per_million: usage.outputUsdPerMillion,
      p_estimated_usd: usage.estimatedUsd, p_usd_krw_rate: usage.usdKrwRate,
      p_estimated_krw: usage.estimatedKrw, p_pricing_as_of: usage.pricingAsOf,
      p_fx_rate_as_of: usage.fxRateAsOf, p_fx_rate_source: usage.fxRateSource,
      p_owner_id: input.ownerId ?? null,
      p_prompt_key: input.promptUsage?.promptKey ?? null,
      p_prompt_version_id: input.promptUsage?.versionId ?? null,
      p_prompt_version_number: input.promptUsage?.versionNumber ?? null,
      p_prompt_source: input.promptUsage?.source ?? 'unknown',
    });
    if (error) throw error;
  }
  async claimAiUsageSession(sessionId: string, ownerId: string): Promise<void> {
    const { error } = await this.db.rpc('claim_ai_usage_session', { p_session_id: sessionId, p_owner_id: ownerId });
    if (error) throw error;
  }
  async getOwned(id: string, ownerId: string): Promise<LearningSet | null> {
    const { data, error } = await this.db.from('learning_set').select('id,title,original_request,selected_topic,learning_goal,status,created_at,updated_at,source_mode,owner_id,flashcard(key_text,values,sort_order)')
      .eq('id', id).eq('owner_id', ownerId).eq('status', 'COMPLETED').maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const { flashcard, ...set } = data as any;
    return { ...set, cards: (flashcard ?? []).sort((a: any, b: any) => a.sort_order - b.sort_order)
      .map((card: any) => ({ key: card.key_text, values: card.values })) } as LearningSet;
  }
  async updateOwned(input: { id: string; ownerId: string; expectedUpdatedAt: string; title: string; cards: Flashcard[]; sourceMode?: ContentSource }): Promise<LearningSet> {
    const { data, error } = await this.db.rpc('update_owned_learning_set', {
      p_owner_id: input.ownerId, p_learning_set_id: input.id, p_expected_updated_at: input.expectedUpdatedAt,
      p_title: input.title, p_cards: input.cards, p_source_mode: input.sourceMode ?? null,
    });
    if (error) throw error;
    return decodeContent(one(data));
  }
  async deleteOwned(id: string, ownerId: string): Promise<boolean> {
    const { data, error } = await this.db.rpc('delete_owned_learning_set', { p_owner_id: ownerId, p_learning_set_id: id });
    if (error) throw error;
    return Boolean(data);
  }

  async loadActivePrompt(key: PromptKey): Promise<ActivePrompt | null> {
    const { data, error } = await this.db.from('ai_prompt_version')
      .select('id,version_number,system_prompt,developer_prompt,user_template,ai_prompt_template!inner(prompt_key,is_enabled)')
      .eq('status', 'ACTIVE').eq('ai_prompt_template.prompt_key', key).eq('ai_prompt_template.is_enabled', true)
      .abortSignal(AbortSignal.timeout(6_000)).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const { ai_prompt_template: _template, ...version } = data as any;
    return version as ActivePrompt;
  }
  async listPromptTemplates(): Promise<PromptTemplateRecord[]> {
    const { data, error } = await this.db.from('ai_prompt_template')
      .select('id,prompt_key,name,description,is_enabled,created_at,ai_prompt_version(id,template_id,version_number,system_prompt,developer_prompt,user_template,status,change_note,created_by,created_at,activated_by,activated_at)')
      .order('prompt_key');
    if (error) throw error;
    return (data ?? []).map((template: any) => ({ ...template,
      versions: (template.ai_prompt_version ?? []).sort((a: PromptVersion, b: PromptVersion) => b.version_number - a.version_number) }));
  }
  private async getPromptTemplateId(key: PromptKey): Promise<string> {
    const { data, error } = await this.db.from('ai_prompt_template').select('id').eq('prompt_key', key).single();
    if (error) throw error;
    return data.id;
  }
  async listPromptVersions(key: PromptKey): Promise<PromptVersion[]> {
    const templateId = await this.getPromptTemplateId(key);
    const { data, error } = await this.db.from('ai_prompt_version').select('*').eq('template_id', templateId).order('version_number', { ascending: false });
    if (error) throw error;
    return (data ?? []) as PromptVersion[];
  }
  async getPromptVersion(key: PromptKey, versionId: string): Promise<PromptVersion | null> {
    const templateId = await this.getPromptTemplateId(key);
    const { data, error } = await this.db.from('ai_prompt_version').select('*').eq('template_id', templateId).eq('id', versionId).maybeSingle();
    if (error) throw error;
    return data as PromptVersion | null;
  }
  async createPromptDraft(key: PromptKey, actorId: string, note: string): Promise<PromptVersion> {
    const { data, error } = await this.db.rpc('create_ai_prompt_draft', { p_prompt_key: key, p_actor_id: actorId, p_change_note: note });
    if (error) throw error;
    return one<PromptVersion>(data);
  }
  async updatePromptDraft(key: PromptKey, versionId: string, actorId: string, value: PromptTemplate, note: string): Promise<PromptVersion> {
    const { data, error } = await this.db.rpc('update_ai_prompt_draft', { p_prompt_key: key, p_version_id: versionId, p_actor_id: actorId,
      p_system_prompt: value.system_prompt, p_developer_prompt: value.developer_prompt, p_user_template: value.user_template, p_change_note: note });
    if (error) throw error;
    return one<PromptVersion>(data);
  }
  async activatePromptVersion(key: PromptKey, versionId: string, actorId: string, expectedActiveVersionId: string): Promise<PromptVersion> {
    const { data, error } = await this.db.rpc('activate_ai_prompt_version', { p_prompt_key: key, p_version_id: versionId,
      p_actor_id: actorId, p_expected_active_version_id: expectedActiveVersionId });
    if (error) throw error;
    return one<PromptVersion>(data);
  }
  async restorePromptVersion(key: PromptKey, sourceVersionId: string, actorId: string, note: string): Promise<PromptVersion> {
    const { data, error } = await this.db.rpc('restore_ai_prompt_version', { p_prompt_key: key, p_source_version_id: sourceVersionId,
      p_actor_id: actorId, p_change_note: note });
    if (error) throw error;
    return one<PromptVersion>(data);
  }
  async listPromptAudit(key: PromptKey, limit: number): Promise<PromptAuditRecord[]> {
    const templateId = await this.getPromptTemplateId(key);
    const { data, error } = await this.db.from('ai_prompt_audit_log').select('*').eq('template_id', templateId)
      .order('created_at', { ascending: false }).limit(Math.min(100, Math.max(1, limit)));
    if (error) throw error;
    return (data ?? []) as PromptAuditRecord[];
  }
}
