import type { Flashcard } from '../../../shared/schemas/index.js';

export type SetStatus = 'GENERATING' | 'COMPLETED' | 'FAILED';
export interface LearningSet {
  id: string; title: string; original_request: string; selected_topic: string; learning_goal: string;
  status: SetStatus; created_at: string; cards?: Flashcard[];
}
export interface LearningRepository {
  search(query: string, limit: number): Promise<LearningSet[]>;
  reserve(input: { requestId: string; originalRequest: string; selectedTopic: string; learningGoal: string }): Promise<{ set: LearningSet; created: boolean }>;
  complete(id: string, title: string, cards: Flashcard[]): Promise<LearningSet>;
  fail(id: string): Promise<void>;
  getCompleted(id: string): Promise<LearningSet | null>;
}
