import { randomUUID } from 'node:crypto';
import type { Flashcard } from '../../../shared/schemas/index.js';
import type { LearningRepository, LearningSet } from './types.js';

export class MemoryLearningRepository implements LearningRepository {
  private readonly sets = new Map<string, LearningSet>();
  private readonly requestIds = new Map<string, string>();
  async search(query: string, limit: number): Promise<LearningSet[]> {
    const q = query.toLocaleLowerCase();
    return [...this.sets.values()].filter(s => s.status === 'COMPLETED' &&
      `${s.title} ${s.original_request}`.toLocaleLowerCase().includes(q)).slice(0, limit);
  }
  async reserve(input: { requestId: string; originalRequest: string; selectedTopic: string; learningGoal: string }): Promise<{ set: LearningSet; created: boolean }> {
    const existingId = this.requestIds.get(input.requestId);
    if (existingId) return { set: this.sets.get(existingId)!, created: false };
    const set: LearningSet = { id: randomUUID(), title: input.selectedTopic, original_request: input.originalRequest,
      selected_topic: input.selectedTopic, learning_goal: input.learningGoal, status: 'GENERATING', created_at: new Date().toISOString() };
    this.sets.set(set.id, set); this.requestIds.set(input.requestId, set.id);
    return { set, created: true };
  }
  async complete(id: string, title: string, cards: Flashcard[]): Promise<LearningSet> {
    const set = this.sets.get(id); if (!set) throw new Error('Learning set was not found.');
    const completed = { ...set, title, status: 'COMPLETED' as const, cards };
    this.sets.set(id, completed); return completed;
  }
  async fail(id: string): Promise<void> { const set = this.sets.get(id); if (set) this.sets.set(id, { ...set, status: 'FAILED' }); }
  async getCompleted(id: string): Promise<LearningSet | null> {
    const set = this.sets.get(id); return set?.status === 'COMPLETED' ? set : null;
  }
}
