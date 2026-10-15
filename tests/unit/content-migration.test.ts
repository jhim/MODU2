import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../../supabase/migrations/202610150002_content_management.sql', import.meta.url), 'utf8');
const sql = migration.split(/\r?\n/).filter(line => !line.trimStart().startsWith('--')).join('\n');

describe('MODU2 content migration invariants', () => {
  it('keeps ownership functions inaccessible to public roles and available to service_role', () => {
    expect(sql).toMatch(/revoke all on function public\.create_owned_learning_set[\s\S]*from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function public\.create_owned_learning_set[\s\S]*to service_role/i);
    expect(sql).toMatch(/revoke all on function public\.update_owned_learning_set[\s\S]*from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function public\.delete_owned_learning_set[\s\S]*to service_role/i);
  });
  it('uses the verified owner and row lock, with an optimistic version check before replacing cards', () => {
    expect(sql).toMatch(/owner_id = p_owner_id[\s\S]*for update/i);
    expect(sql).toMatch(/updated_at <> p_expected_updated_at/i);
    expect(sql.indexOf('updated_at <> p_expected_updated_at')).toBeLessThan(sql.indexOf('delete from public.flashcard'));
  });
  it('preserves old unowned content and withholds owner ids from public column grants', () => {
    expect(sql).toMatch(/add column if not exists owner_id uuid references auth\.users\(id\) on delete set null/i);
    expect(sql).toMatch(/revoke select on table public\.learning_set from anon, authenticated/i);
    expect(sql).toMatch(/grant select \(id, title[\s\S]*source_mode\)[\s\S]*to anon, authenticated/i);
  });
  it('stores an owner-only pre-edit snapshot and provides an owner-scoped atomic recovery RPC', () => {
    expect(sql).toMatch(/create table if not exists public\.learning_set_revision[\s\S]*enable row level security/i);
    expect(sql).toMatch(/insert into public\.learning_set_revision[\s\S]*delete from public\.flashcard/i);
    expect(sql).toMatch(/create or replace function public\.restore_owned_learning_set_revision[\s\S]*for update[\s\S]*p_revision_id[\s\S]*owner_id = p_owner_id/i);
    expect(sql).toMatch(/grant execute on function public\.restore_owned_learning_set_revision[\s\S]*to service_role/i);
  });  it('uses rerunnable additive DDL for columns, table, indexes, constraints, and RPC definitions', () => {
    expect(sql).toMatch(/add column if not exists owner_id/i);
    expect(sql).toMatch(/add column if not exists source_mode/i);
    expect(sql).toMatch(/if not exists \(select 1 from pg_catalog\.pg_constraint/i);
    expect(sql).toMatch(/create table if not exists public\.learning_set_revision/i);
    expect(sql).toMatch(/create index if not exists/i);
    expect(sql).toMatch(/create or replace function public\.list_learning_sets/i);
  });  it('does not drop or truncate existing data and scopes deletion to one owner', () => {
    expect(sql).not.toMatch(/\bdrop table\b|\btruncate\b/i);
    expect(sql).toMatch(/delete from public\.learning_set where id = p_learning_set_id and owner_id = p_owner_id and status = 'COMPLETED'/i);
  });
});
