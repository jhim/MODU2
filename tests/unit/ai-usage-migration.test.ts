import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../../supabase/migrations/202610150003_ai_usage_costs.sql', import.meta.url), 'utf8');
const sql = migration.split(/\r?\n/).filter(line => !line.trimStart().startsWith('--')).join('\n');

describe('AI usage cost migration', () => {
  it('adds nullable usage linkage without rewriting existing learning sets', () => {
    expect(sql).toMatch(/add column if not exists ai_usage_session_id uuid/i);
    expect(sql).toMatch(/create unique index if not exists learning_set_ai_usage_session_id_uidx/i);
    const linkFunctionOffset = sql.indexOf('create or replace function public.attach_ai_usage_session');
    expect(sql.slice(0, linkFunctionOffset)).not.toMatch(/update public\.learning_set/i);
  });

  it('stores actual input, output, total and cached tokens with immutable rate snapshots', () => {
    for (const field of ['input_tokens', 'output_tokens', 'total_tokens', 'cached_input_tokens',
      'input_usd_per_million', 'cached_input_usd_per_million', 'output_usd_per_million',
      'estimated_usd', 'usd_krw_rate', 'estimated_krw', 'pricing_as_of', 'fx_rate_as_of', 'fx_rate_source']) {
      expect(sql).toContain(field);
    }
    expect(sql).toMatch(/total_tokens integer not null check \(total_tokens = input_tokens \+ output_tokens\)/i);
  });

  it('keeps event data private and allows only service_role to write it or attach sessions', () => {
    expect(sql).toMatch(/alter table public\.ai_usage_event enable row level security/i);
    expect(sql).toMatch(/revoke all on table public\.ai_usage_event from public, anon, authenticated/i);
    expect(sql).toMatch(/grant select, insert on table public\.ai_usage_event to service_role/i);
    expect(sql).toMatch(/revoke all on function public\.attach_ai_usage_session[\s\S]*from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function public\.attach_ai_usage_session[\s\S]*to service_role/i);
    expect(sql).toMatch(/create table if not exists public\.ai_usage_session_claim/i);
    expect(sql).toMatch(/create table if not exists public\.ai_usage_session_claim\s*\(\s*session_id uuid primary key,\s*owner_id uuid not null,/i);
    expect(sql).not.toMatch(/owner_id uuid not null references auth\.users\(id\) on delete cascade/i);
    expect(sql).toMatch(/grant execute on function public\.claim_ai_usage_session\(uuid, uuid\)[\s\S]*to service_role/i);
    expect(sql).toMatch(/create or replace function public\.record_ai_usage_event/i);
    expect(sql).toMatch(/grant execute on function public\.record_ai_usage_event[\s\S]*to service_role/i);
    expect(sql).toMatch(/usage session belongs to another user/i);
  });

  it('adds aggregated usage only to the existing completed-content listing RPC', () => {
    expect(sql).toMatch(/create or replace function public\.list_learning_sets/i);
    expect(sql).toMatch(/'ai_usage',[\s\S]*from public\.ai_usage_event e where e\.session_id = ls\.ai_usage_session_id/i);
    expect(sql).toMatch(/from public\.ai_usage_event e where e\.session_id = ls\.ai_usage_session_id\s+having count\(\*\) > 0/i);
    expect(sql).toMatch(/revoke all on function public\.list_learning_sets[\s\S]*from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function public\.list_learning_sets[\s\S]*to service_role/i);
    expect(sql).not.toMatch(/\bdrop table\b|\btruncate\b/i);
  });
});
