import { describe, expect, it } from 'vitest';
import type { Flashcard } from '../../shared/schemas/index.js';
import { toFlashcardRpcPayload } from '../../server/src/repositories/supabase.js';

describe('Supabase flashcard RPC payload', () => {
  it('assigns sort_order 1 through 10 from the generated array order', () => {
    const cards: Flashcard[] = Array.from({ length: 10 }, (_, index) => ({
      key: `term-${index + 1}`,
      values: [`definition-${index + 1}`],
    }));

    const payload = toFlashcardRpcPayload(cards);

    expect(payload).toHaveLength(10);
    expect(payload.map(card => card.sort_order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(payload[0]).toEqual({ key_text: 'term-1', values: ['definition-1'], sort_order: 1 });
    expect(Object.keys(cards[0])).toEqual(['key', 'values']);
  });
});
