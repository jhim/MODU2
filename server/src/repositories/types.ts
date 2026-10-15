import type { Flashcard } from '../../../shared/schemas/index.js';

export type SetStatus = 'GENERATING' | 'COMPLETED' | 'FAILED';
export type ContentSource = 'AI' | 'PHOTO' | 'TEXT' | 'EXCEL';
export interface LearningSet {
  id: string; title: string; original_request: string; selected_topic: string; learning_goal: string;
  status: SetStatus; created_at: string; updated_at?: string; source_mode?: ContentSource;
  owner_id?: string | null; cards?: Flashcard[];
}
export interface ContentListItem extends Omit<LearningSet, 'cards'> {
  card_count: number; preview: Flashcard[]; can_edit: boolean;
}
export interface ContentListResult {
  results: ContentListItem[]; total: number; page: number; page_size: number; total_pages: number;
}
export interface LearningRepository {
  readonly allowAnonymousPersistence?: boolean;
  search(query: string, limit: number): Promise<LearningSet[]>;
  reserve(input: { requestId: string; originalRequest: string; selectedTopic: string; learningGoal: string; ownerId?: string }): Promise<{ set: LearningSet; created: boolean }>;
  complete(id: string, title: string, cards: Flashcard[]): Promise<LearningSet>;
  fail(id: string): Promise<void>;
  getCompleted(id: string): Promise<LearningSet | null>;
  listContent(input: { query: string; sort: 'newest' | 'name'; page: number; pageSize: number; ownerId?: string; scope: 'all' | 'mine' }): Promise<ContentListResult>;
  createOwned(input: { ownerId: string; title: string; cards: Flashcard[]; sourceMode: ContentSource }): Promise<LearningSet>;
  getOwned(id: string, ownerId: string): Promise<LearningSet | null>;
  updateOwned(input: { id: string; ownerId: string; expectedUpdatedAt: string; title: string; cards: Flashcard[]; sourceMode?: ContentSource }): Promise<LearningSet>;
  deleteOwned(id: string, ownerId: string): Promise<boolean>;
  verifyAccessToken(token: string): Promise<{ id: string; email?: string } | null>;
}
