import { randomUUID } from 'node:crypto';
import type { AiUsageSummary, Flashcard } from '../../../shared/schemas/index.js';
import type { ContentSource, LearningRepository, LearningSet, ContentListResult } from './types.js';
import type { AiUsageRecord } from '../services/ai-pricing.js';

type StoredAiUsage = AiUsageRecord & { request_id: string; operation: 'suggestions' | 'flashcard_generation' | 'image_extraction' };

function summarizeAiUsage(events: StoredAiUsage[]): AiUsageSummary | undefined {
  if (!events.length) return undefined;
  const allPriced = events.every(event => event.estimatedUsd !== null && event.estimatedKrw !== null);
  return {
    input_tokens: events.reduce((sum, event) => sum + event.inputTokens, 0),
    output_tokens: events.reduce((sum, event) => sum + event.outputTokens, 0),
    total_tokens: events.reduce((sum, event) => sum + event.totalTokens, 0),
    cached_input_tokens: events.reduce((sum, event) => sum + event.cachedInputTokens, 0),
    estimated_usd: allPriced ? events.reduce((sum, event) => sum + (event.estimatedUsd ?? 0), 0) : null,
    estimated_krw: allPriced ? events.reduce((sum, event) => sum + (event.estimatedKrw ?? 0), 0) : null,
    models: [...new Set(events.map(event => event.model))],
    operations: [...new Set(events.map(event => event.operation))],
    pricing_as_of: [...new Set(events.map(event => event.pricingAsOf))],
    fx_rate_as_of: [...new Set(events.map(event => event.fxRateAsOf))],
    fx_rate_source: [...new Set(events.map(event => event.fxRateSource))],
    model_rates: [...new Map(events.map(event => [event.model + ':' + event.pricingAsOf, {
      model: event.model, input_usd_per_million: event.inputUsdPerMillion,
      cached_input_usd_per_million: event.cachedInputUsdPerMillion, output_usd_per_million: event.outputUsdPerMillion,
      pricing_as_of: event.pricingAsOf,
    }])).values()],
    fx_rates: [...new Map(events.map(event => [event.usdKrwRate + ':' + event.fxRateAsOf, {
      usd_krw_rate: event.usdKrwRate, as_of: event.fxRateAsOf, source: event.fxRateSource,
    }])).values()],
  };
}

export class MemoryLearningRepository implements LearningRepository {
  readonly allowAnonymousPersistence = true;
  private readonly sets = new Map<string, LearningSet>();
  private readonly requestIds = new Map<string, string>();
  private readonly aiUsage = new Map<string, StoredAiUsage[]>();
  private readonly aiUsageOwners = new Map<string, string>();
  async verifyAccessToken(_token: string) { return null; }
  async search(query: string, limit: number): Promise<LearningSet[]> {
    const q = query.toLocaleLowerCase();
    return [...this.sets.values()].filter(set => set.status === 'COMPLETED' &&
      (set.title + ' ' + set.original_request).toLocaleLowerCase().includes(q)).slice(0, limit);
  }
  async reserve(input: { requestId: string; originalRequest: string; selectedTopic: string; learningGoal: string; ownerId?: string; aiUsageSessionId?: string }): Promise<{ set: LearningSet; created: boolean }> {
    if (input.aiUsageSessionId) this.claimUsageSession(input.aiUsageSessionId, input.ownerId);
    const existingId = this.requestIds.get(input.requestId);
    if (existingId) return { set: this.sets.get(existingId)!, created: false };
    const now = new Date().toISOString();
    const set: LearningSet = { id: randomUUID(), title: input.selectedTopic, original_request: input.originalRequest,
      selected_topic: input.selectedTopic, learning_goal: input.learningGoal, status: 'GENERATING',
      created_at: now, updated_at: now, source_mode: 'AI', owner_id: input.ownerId ?? null,
      ai_usage_session_id: input.aiUsageSessionId ?? null };
    this.sets.set(set.id, set); this.requestIds.set(input.requestId, set.id);
    return { set, created: true };
  }
  async complete(id: string, title: string, cards: Flashcard[]): Promise<LearningSet> {
    const set = this.sets.get(id); if (!set) throw new Error('Learning set was not found.');
    const completed = { ...set, title, status: 'COMPLETED' as const, cards, updated_at: new Date().toISOString() };
    this.sets.set(id, completed); return completed;
  }
  async fail(id: string): Promise<void> { const set = this.sets.get(id); if (set) this.sets.set(id, { ...set, status: 'FAILED' }); }
  async getCompleted(id: string): Promise<LearningSet | null> {
    const set = this.sets.get(id); return set?.status === 'COMPLETED' ? set : null;
  }
  async listContent(input: { query: string; sort: 'newest' | 'name'; page: number; pageSize: number; ownerId?: string; scope: 'all' | 'mine' }): Promise<ContentListResult> {
    const query = input.query.toLocaleLowerCase();
    let sets = [...this.sets.values()].filter(set => set.status === 'COMPLETED' &&
      (input.scope !== 'mine' || set.owner_id === input.ownerId) &&
      ((set.title + ' ' + set.original_request + ' ' + (set.cards ?? []).map(card => card.key + ' ' + card.values.join(' ')).join(' ')).toLocaleLowerCase().includes(query)));
    sets.sort(input.sort === 'name' ? (a, b) => a.title.localeCompare(b.title) : (a, b) => b.created_at.localeCompare(a.created_at));
    const total = sets.length;
    const totalPages = Math.max(1, Math.ceil(total / input.pageSize));
    sets = sets.slice((input.page - 1) * input.pageSize, input.page * input.pageSize);
    return { results: sets.map(set => { const { ai_usage_session_id, ...publicSet } = set; return { ...publicSet, card_count: set.cards?.length ?? 0,
      preview: (set.cards ?? []).slice(0, 2), can_edit: Boolean(input.ownerId && input.ownerId === set.owner_id),
      ai_usage: ai_usage_session_id ? summarizeAiUsage(this.aiUsage.get(ai_usage_session_id) ?? []) : undefined }; }),
      total, page: input.page, page_size: input.pageSize, total_pages: totalPages };
  }
  async createOwned(input: { ownerId: string; title: string; cards: Flashcard[]; sourceMode: ContentSource; aiUsageSessionId?: string }): Promise<LearningSet> {
    if (input.aiUsageSessionId) this.claimUsageSession(input.aiUsageSessionId, input.ownerId);
    if (input.aiUsageSessionId && [...this.sets.values()].some(set => set.ai_usage_session_id === input.aiUsageSessionId)) {
      throw new Error('AI usage session is already linked to content.');
    }
    const now = new Date().toISOString();
    const set: LearningSet = { id: randomUUID(), title: input.title, original_request: input.title, selected_topic: input.title,
      learning_goal: '직접 만든 학습 콘텐츠', status: 'COMPLETED', created_at: now, updated_at: now,
      owner_id: input.ownerId, source_mode: input.sourceMode, cards: input.cards,
      ai_usage_session_id: input.aiUsageSessionId ?? null };
    this.sets.set(set.id, set); return set;
  }
  async recordAiUsage(input: { sessionId: string; requestId: string; operation: 'suggestions' | 'flashcard_generation' | 'image_extraction'; usage: AiUsageRecord; ownerId?: string }): Promise<void> {
    this.claimUsageSession(input.sessionId, input.ownerId);
    const events = this.aiUsage.get(input.sessionId) ?? [];
    events.push({ ...input.usage, request_id: input.requestId, operation: input.operation });
    this.aiUsage.set(input.sessionId, events);
  }
  async claimAiUsageSession(sessionId: string, ownerId: string): Promise<void> { this.claimUsageSession(sessionId, ownerId); }
  private claimUsageSession(sessionId: string, ownerId?: string) {
    const currentOwner = this.aiUsageOwners.get(sessionId);
    if (ownerId) {
      if (currentOwner && currentOwner !== ownerId) throw new Error('AI usage session belongs to another user.');
      this.aiUsageOwners.set(sessionId, ownerId);
    } else if (currentOwner) throw new Error('AI usage session requires its owner.');
  }
  async getOwned(id: string, ownerId: string): Promise<LearningSet | null> {
    const set = this.sets.get(id); return set?.status === 'COMPLETED' && set.owner_id === ownerId ? set : null;
  }
  async updateOwned(input: { id: string; ownerId: string; expectedUpdatedAt: string; title: string; cards: Flashcard[]; sourceMode?: ContentSource }): Promise<LearningSet> {
    const set = await this.getOwned(input.id, input.ownerId);
    if (!set) throw Object.assign(new Error('content not found or not owned'), { code: 'P0002' });
    if (set.updated_at !== input.expectedUpdatedAt) throw Object.assign(new Error('content changed since it was loaded'), { code: '40001' });
    const updated = { ...set, title: input.title, cards: input.cards, updated_at: new Date().toISOString(),
      ...(input.sourceMode ? { source_mode: input.sourceMode } : {}) };
    this.sets.set(set.id, updated); return updated;
  }
  async deleteOwned(id: string, ownerId: string): Promise<boolean> {
    const set = await this.getOwned(id, ownerId); if (!set) return false;
    this.sets.delete(id); return true;
  }
}
