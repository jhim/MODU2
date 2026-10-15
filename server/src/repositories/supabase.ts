import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Flashcard } from '../../../shared/schemas/index.js';
import type { LearningRepository, LearningSet } from './types.js';

export function toFlashcardRpcPayload(cards: Flashcard[]) {
  return cards.map((card, index) => ({
    key_text: card.key,
    values: card.values,
    sort_order: index + 1,
  }));
}

export class SupabaseLearningRepository implements LearningRepository {
  private constructor(private readonly db: SupabaseClient) {}
  static fromEnv(url: string, key: string): SupabaseLearningRepository {
    return new SupabaseLearningRepository(createClient(url, key, { auth: { persistSession: false } }));
  }
  async search(query: string, limit: number): Promise<LearningSet[]> {
    const { data, error } = await this.db.rpc('search_completed_learning_sets', { p_query: query, p_limit: limit });
    if (error) throw error;
    return (data ?? []) as LearningSet[];
  }
  async reserve(input: { requestId: string; originalRequest: string; selectedTopic: string; learningGoal: string }): Promise<{ set: LearningSet; created: boolean }> {
    const row = { client_request_id: input.requestId, title: input.selectedTopic, original_request: input.originalRequest,
      selected_topic: input.selectedTopic, learning_goal: input.learningGoal, status: 'GENERATING' };
    const inserted = await this.db.from('learning_set').insert(row).select('id,title,original_request,selected_topic,learning_goal,status,created_at').maybeSingle();
    if (!inserted.error && inserted.data) return { set: inserted.data as LearningSet, created: true };
    // A unique client_request_id is the durable idempotency key across instances/restarts.
    const existing = await this.db.from('learning_set').select('id,title,original_request,selected_topic,learning_goal,status,created_at')
      .eq('client_request_id', input.requestId).maybeSingle();
    if (existing.error || !existing.data) throw inserted.error ?? existing.error;
    return { set: existing.data as LearningSet, created: false };
  }
  async complete(id: string, title: string, cards: Flashcard[]): Promise<LearningSet> {
    const { data, error } = await this.db.rpc('complete_learning_set', {
      p_learning_set_id: id, p_title: title,
      p_cards: toFlashcardRpcPayload(cards),
    });
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    return { ...result, cards } as LearningSet;
  }
  async fail(id: string): Promise<void> {
    const { error } = await this.db.from('learning_set').update({ status: 'FAILED', updated_at: new Date().toISOString() })
      .eq('id', id).eq('status', 'GENERATING');
    if (error) throw error;
  }
  async getCompleted(id: string): Promise<LearningSet | null> {
    const { data, error } = await this.db.from('learning_set').select('id,title,original_request,selected_topic,learning_goal,status,created_at,flashcard(key_text,values,sort_order)')
      .eq('id', id).eq('status', 'COMPLETED').maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const { flashcard, ...set } = data as any;
    return { ...set, cards: (flashcard ?? []).sort((a: any, b: any) => a.sort_order - b.sort_order).map((c: any) => ({ key: c.key_text, values: c.values })) } as LearningSet;
  }
}
