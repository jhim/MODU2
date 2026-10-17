import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('../../supabase/migrations/202610150004_ai_prompt_management.sql', import.meta.url), 'utf8');
const executableSql = sql.replace(/^\s*--.*$/gm, '');

describe('AI prompt management migration contract', () => {
  it('creates prompt catalog, version and audit tables with the one-active invariant', () => {
    for (const table of ['ai_prompt_template', 'ai_prompt_version', 'ai_prompt_audit_log']) expect(sql).toContain(`create table if not exists public.${table}`);
    expect(sql).toContain("check (prompt_key in ('RECOMMEND', 'FLASHCARD'))");
    expect(sql).toContain('unique (template_id, version_number)');
    expect(sql).toContain('on public.ai_prompt_version(template_id) where status = \'ACTIVE\'');
  });
  it('enables RLS, revokes public-role table access and grants only service-role reads and RPC execution', () => {
    expect(sql.match(/enable row level security/g)).toHaveLength(3);
    expect(sql).toContain('from public, anon, authenticated, service_role');
    expect(sql).toContain('to service_role');
    for (const fn of ['create_ai_prompt_draft', 'update_ai_prompt_draft', 'activate_ai_prompt_version', 'restore_ai_prompt_version']) {
      expect(sql).toMatch(new RegExp(`function public\\.${fn}\\([\\s\\S]*?security definer set search_path = pg_catalog`));
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${fn}`));
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${fn}.*to service_role`));
    }
  });
  it('locks the template and checks the active version before transactional activation', () => {
    expect(sql).toContain('where prompt_key = p_prompt_key and is_enabled for update');
    expect(sql).toContain('v_current_id is distinct from p_expected_active_version_id');
    expect(sql).toContain("using errcode = '40001'");
  });
  it('wraps all DDL and seed data in one transaction and avoids version-number collisions on repair runs', () => {
    expect(sql.trimStart().startsWith('--')).toBe(true);
    expect(sql).toContain('\nbegin;');
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
    expect(sql).toContain('max(existing.version_number) + 1');
    expect(sql).toContain('on conflict (prompt_key) do nothing');
    expect(sql).toContain('where not exists (select 1 from public.ai_prompt_version v where v.template_id = t.id);');
  });
  it('does not drop, truncate, update, or delete existing learning content', () => {
    expect(executableSql).not.toMatch(/^\s*(drop|truncate|delete\s+from|update\s+public\.(learning_set|flashcard))\b/im);
    expect(executableSql).not.toContain('public.learning_set');
    expect(executableSql).not.toContain('public.flashcard');
  });
});
