import { randomUUID } from 'node:crypto';
import type { Flashcard } from '../../../shared/schemas/index.js';
import type { ContentSource, LearningRepository, LearningSet, ContentListResult } from './types.js';

export class MemoryLearningRepository implements LearningRepository {
  readonly allowAnonymousPersistence = true;
  private readonly sets = new Map<string, LearningSet>();
  private readonly requestIds = new Map<string, string>();
  async verifyAccessToken(_token: string) { return null; }
  async search(query: string, limit: number): Promise<LearningSet[]> {
    const q = query.toLocaleLowerCase();
    return [...this.sets.values()].filter(set => set.status === 'COMPLETED' &&
      (set.title + ' ' + set.original_request).toLocaleLowerCase().includes(q)).slice(0, limit);
  }
  async reserve(input: { requestId: string; originalRequest: string; selectedTopic: string; learningGoal: string; ownerId?: string }): Promise<{ set: LearningSet; created: boolean }> {
    const existingId = this.requestIds.get(input.requestId);
    if (existingId) return { set: this.sets.get(existingId)!, created: false };
    const now = new Date().toISOString();
    const set: LearningSet = { id: randomUUID(), title: input.selectedTopic, original_request: input.originalRequest,
      selected_topic: input.selectedTopic, learning_goal: input.learningGoal, status: 'GENERATING',
      created_at: now, updated_at: now, source_mode: 'AI', owner_id: input.ownerId ?? null };
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
    return { results: sets.map(set => ({ ...set, card_count: set.cards?.length ?? 0,
      preview: (set.cards ?? []).slice(0, 2), can_edit: Boolean(input.ownerId && input.ownerId === set.owner_id) })),
      total, page: input.page, page_size: input.pageSize, total_pages: totalPages };
  }
  async createOwned(input: { ownerId: string; title: string; cards: Flashcard[]; sourceMode: ContentSource }): Promise<LearningSet> {
    const now = new Date().toISOString();
    const set: LearningSet = { id: randomUUID(), title: input.title, original_request: input.title, selected_topic: input.title,
      learning_goal: '직접 만든 학습 콘텐츠', status: 'COMPLETED', created_at: now, updated_at: now,
      owner_id: input.ownerId, source_mode: input.sourceMode, cards: input.cards };
    this.sets.set(set.id, set); return set;
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
