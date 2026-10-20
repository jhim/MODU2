import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../../supabase/migrations/202610150005_ai_usage_prompt_versions.sql', import.meta.url), 'utf8');
const sql = migration.split(/\r?\n/).filter(line => !line.trimStart().startsWith('--')).join('\n');

describe('AI usage operation and prompt attribution migration', () => {
  it('is transactional, incremental, and leaves historical records unattributed', () => {
    expect(sql.trimStart()).toMatch(/^begin;/i);
    expect(sql.trimEnd()).toMatch(/commit;$/i);
    expect(sql).toMatch(/add column if not exists prompt_key text/i);
    expect(sql).toMatch(/add column if not exists prompt_version_id uuid/i);
    expect(sql).toMatch(/add column if not exists prompt_version_number integer/i);
    expect(sql).toMatch(/add column if not exists prompt_source text not null default 'unknown'/i);
    expect(sql).not.toMatch(/update public\.(learning_set|flashcard|ai_usage_event)/i);
    expect(sql).not.toMatch(/\b(drop|truncate)\s+(table|column)\b/i);
  });

  it('keeps usage writes service-role only and validates prompt snapshot identity', () => {
    expect(sql).toMatch(/references public\.ai_prompt_version\(id\) on delete set null/i);
    expect(sql).toMatch(/where v\.id = p_prompt_version_id and v\.version_number = p_prompt_version_number\s+and t\.prompt_key = p_prompt_key/i);
    expect(sql).toMatch(/p_prompt_source = 'active' and p_prompt_version_id is null/i);
    expect(sql).toMatch(/p_prompt_source in \('fallback', 'code'\) and p_prompt_version_id is not null/i);
    expect(sql).toMatch(/revoke all on function public\.record_ai_usage_event[\s\S]*from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function public\.record_ai_usage_event[\s\S]*to service_role/i);
  });

  it('adds operation-level cost and prompt version details to the existing listing result', () => {
    expect(sql).toMatch(/'by_operation',[\s\S]*op_summary\.operation[\s\S]*op_summary\.estimated_krw/i);
    expect(sql).toMatch(/op_summary\.prompt_key[\s\S]*op_summary\.prompt_version_number[\s\S]*op_summary\.prompt_source/i);
    expect(sql).toMatch(/\) op_summary\)\)\s+from public\.ai_usage_event e where e\.session_id = ls\.ai_usage_session_id/i);
    expect(sql).toMatch(/having count\(\*\) > 0\)/i);
    const body = sql.match(/create or replace function public\.list_learning_sets\([\s\S]*?as \$\$([\s\S]*?)\$\$;/i)?.[1];
    expect(body).toBeTruthy();
    let depth = 0;
    let quote: "'" | '"' | null = null;
    for (let i = 0; i < body!.length; i++) {
      const char = body![i];
      if (quote) {
        if (char === quote && body![i + 1] === quote) i++;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === "'" || char === '"') { quote = char; continue; }
      if (char === '(') depth++;
      if (char === ')') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(quote).toBeNull();
    expect(depth).toBe(0);
    expect(sql).toMatch(/revoke all on function public\.list_learning_sets[\s\S]*from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function public\.list_learning_sets[\s\S]*to service_role/i);
  });
});
