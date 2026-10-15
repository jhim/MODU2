import { z } from 'zod';

export const SuggestionSchema = z.object({
  id: z.string().min(1).max(40),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(240),
  learning_goal: z.string().trim().min(1).max(240),
});
export const SuggestionsResponseSchema = z.object({
  message: z.string().trim().min(1).max(240),
  suggestions: z.array(SuggestionSchema).min(2).max(3),
});
export const SuggestionRequestSchema = z.object({
  original_request: z.string().trim().min(1).max(200),
  refinement_request: z.string().trim().max(200).default(''),
  previous_suggestions: z.array(SuggestionSchema).max(10).default([]),
});
const trimmedTextMaxCodePoints = (max: number) => z.string().trim().min(1).refine(
  value => Array.from(value).length <= max,
  { message: 'Must contain at most ' + max + ' characters.' },
);
export const FlashcardSchema = z.object({
  key: trimmedTextMaxCodePoints(120),
  values: z.array(trimmedTextMaxCodePoints(500)).min(1).max(6),
});
export const EditableCardsSchema = z.array(FlashcardSchema).min(1).max(500);
export const GeneratedSetSchema = z.object({
  title: z.string().trim().min(1).max(120),
  cards: z.array(FlashcardSchema).length(10),
}).superRefine(({ cards }, ctx) => {
  const keys = cards.map(({ key }) => key.trim().toLowerCase());
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', path: ['cards'], message: 'Flashcard keys must be unique.' });
});
export const CreateSetRequestSchema = z.object({
  original_request: z.string().trim().min(1).max(200),
  selected_topic: z.string().trim().min(1).max(160),
  learning_goal: z.string().trim().min(1).max(240),
  client_request_id: z.string().uuid(),
});
export const ImportedSetRequestSchema = z.object({
  title: z.string().trim().min(1).max(120),
  cards: EditableCardsSchema,
  source_mode: z.enum(['AI', 'PHOTO', 'TEXT', 'EXCEL']),
});
export const UpdateSetRequestSchema = ImportedSetRequestSchema.extend({
  expected_updated_at: z.string().datetime(),
});
export const ListQuerySchema = z.object({
  q: z.string().trim().max(120).default(''),
  sort: z.enum(['newest', 'name']).default('newest'),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(50).default(20),
  scope: z.enum(['all', 'mine']).default('all'),
});
export const SearchQuerySchema = z.string().trim().min(1).max(100);
export type Suggestion = z.infer<typeof SuggestionSchema>;
export type SuggestionsResponse = z.infer<typeof SuggestionsResponseSchema>;
export type Flashcard = z.infer<typeof FlashcardSchema>;
export type GeneratedSet = z.infer<typeof GeneratedSetSchema>;
export type CreateSetRequest = z.infer<typeof CreateSetRequestSchema>;
