import { describe, expect, it } from 'vitest';
import { GeneratedSetSchema, SuggestionsResponseSchema } from '../../shared/schemas/index';

const suggestions = (count: number) => ({ message: '주제를 선택하세요', suggestions: Array.from({ length: count }, (_, i) => ({
  id: `s${i}`, title: `주제 ${i}`, description: '설명', learning_goal: '목표',
})) });
const cards = () => Array.from({ length: 10 }, (_, i) => ({ key: `항목 ${i}`, values: ['설명'] }));

describe('AI response schemas', () => {
  it('accepts only 2–3 suggestions', () => {
    expect(SuggestionsResponseSchema.safeParse(suggestions(2)).success).toBe(true);
    expect(SuggestionsResponseSchema.safeParse(suggestions(3)).success).toBe(true);
    expect(SuggestionsResponseSchema.safeParse(suggestions(1)).success).toBe(false);
    expect(SuggestionsResponseSchema.safeParse(suggestions(4)).success).toBe(false);
  });
  it('requires exactly 10 cards', () => {
    const parsed = GeneratedSetSchema.safeParse({ title: 'set', cards: cards() });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(Object.keys(parsed.data.cards[0])).toEqual(['key', 'values']);
    expect(GeneratedSetSchema.safeParse({ title: 'set', cards: cards().slice(0, 9) }).success).toBe(false);
  });
  it('rejects empty key, empty values, duplicated keys and long strings', () => {
    const valid = cards();
    expect(GeneratedSetSchema.safeParse({ title: 'set', cards: [{ ...valid[0], key: ' ' }, ...valid.slice(1)] }).success).toBe(false);
    expect(GeneratedSetSchema.safeParse({ title: 'set', cards: [{ ...valid[0], values: [] }, ...valid.slice(1)] }).success).toBe(false);
    expect(GeneratedSetSchema.safeParse({ title: 'set', cards: [{ ...valid[0], values: Array(7).fill('value') }, ...valid.slice(1)] }).success).toBe(false);
    expect(GeneratedSetSchema.safeParse({ title: 'set', cards: [{ ...valid[0], key: valid[1].key }, ...valid.slice(1)] }).success).toBe(false);
    expect(GeneratedSetSchema.safeParse({ title: 'set', cards: [{ ...valid[0], key: 'k'.repeat(121) }, ...valid.slice(1)] }).success).toBe(false);
    expect(GeneratedSetSchema.safeParse({ title: 'set', cards: [{ ...valid[0], values: ['x'.repeat(501)] }, ...valid.slice(1)] }).success).toBe(false);
    expect(GeneratedSetSchema.safeParse({ title: 'set', cards: [{ ...valid[0], values: ['  '] }, ...valid.slice(1)] }).success).toBe(false);
    expect(GeneratedSetSchema.safeParse({ title: 'set', cards: [
      { key: 'Python', values: ['one'] },
      { key: 'python', values: ['two'] },
      ...valid.slice(2),
    ] }).success).toBe(false);
  });
});
