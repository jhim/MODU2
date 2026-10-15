-- MODU2 only. Review this migration before applying it to a newly created Supabase project.
create extension if not exists pgcrypto;

-- Match the whitespace characters removed by JavaScript String.trim().
create or replace function public.trim_flashcard_text(p_value text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select btrim(
    p_value,
    chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760) ||
    chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198) ||
    chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239) ||
    chr(8287) || chr(12288) || chr(65279)
  );
$$;

-- Shared by the table constraint and completion RPC so stored values follow
-- the same shape as the application schema (1-6 non-blank strings, <=500 chars).
create or replace function public.is_valid_flashcard_values(p_values jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  v_value jsonb;
  v_text text;
begin
  if p_values is null or jsonb_typeof(p_values) is distinct from 'array' then
    return false;
  end if;
  if jsonb_array_length(p_values) < 1 or jsonb_array_length(p_values) > 6 then
    return false;
  end if;

  for v_value in select value from jsonb_array_elements(p_values) as values_array(value) loop
    if jsonb_typeof(v_value) is distinct from 'string' then
      return false;
    end if;
    v_text := public.trim_flashcard_text(v_value #>> '{}');
    if char_length(v_text) not between 1 and 500 then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

revoke all on function public.is_valid_flashcard_values(jsonb) from public, anon, authenticated;
revoke all on function public.trim_flashcard_text(text) from public, anon, authenticated;
grant execute on function public.is_valid_flashcard_values(jsonb) to service_role;
grant execute on function public.trim_flashcard_text(text) to service_role;

create table public.learning_set (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  original_request text not null,
  selected_topic text not null,
  learning_goal text not null,
  status text not null check (status in ('GENERATING', 'COMPLETED', 'FAILED')),
  client_request_id uuid not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.flashcard (
  id uuid primary key default gen_random_uuid(),
  learning_set_id uuid not null references public.learning_set(id) on delete cascade,
  key_text text not null check (char_length(public.trim_flashcard_text(key_text)) between 1 and 120),
  "values" jsonb not null check (public.is_valid_flashcard_values("values")),
  sort_order integer not null check (sort_order > 0),
  created_at timestamptz not null default now(),
  unique (learning_set_id, sort_order)
);
-- The UNIQUE constraint above already creates an index on (learning_set_id, sort_order).
create unique index flashcard_set_key_idx
  on public.flashcard (learning_set_id, lower(public.trim_flashcard_text(key_text)));

alter table public.learning_set enable row level security;
alter table public.flashcard enable row level security;
create policy "public can read completed learning sets" on public.learning_set
  for select to anon, authenticated using (status = 'COMPLETED');
create policy "public can read cards from completed sets" on public.flashcard
  for select to anon, authenticated using (
    exists (select 1 from public.learning_set ls where ls.id = learning_set_id and ls.status = 'COMPLETED')
  );
-- Explicitly prevent direct writes through the public PostgREST roles, even if
-- project-level default grants change. The server uses only the service role key.
revoke all on table public.learning_set, public.flashcard from public, anon, authenticated;
grant select on public.learning_set, public.flashcard to anon, authenticated;
grant select, insert, update, delete on table public.learning_set, public.flashcard to service_role;

create or replace function public.search_completed_learning_sets(p_query text, p_limit integer default 5)
returns table (id uuid, title text, original_request text, selected_topic text, learning_goal text,
  status text, created_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_pattern text;
  v_escape text := chr(92);
begin
  -- Treat LIKE metacharacters as user text, not as a filter expression.
  v_pattern := '%' || replace(
    replace(
      replace(p_query, v_escape, v_escape || v_escape),
      '%', v_escape || '%'
    ),
    '_', v_escape || '_'
  ) || '%';
  return query
  select ls.id, ls.title, ls.original_request, ls.selected_topic, ls.learning_goal, ls.status, ls.created_at
  from public.learning_set ls
  where ls.status = 'COMPLETED'
    and (ls.title ILIKE v_pattern ESCAPE '\' or ls.original_request ILIKE v_pattern ESCAPE '\')
  order by ls.created_at desc
  limit greatest(1, least(coalesce(p_limit, 5), 5));
end;
$$;
revoke all on function public.search_completed_learning_sets(text, integer) from public, anon, authenticated;
grant execute on function public.search_completed_learning_sets(text, integer) to service_role;

create or replace function public.complete_learning_set(
  p_learning_set_id uuid,
  p_title text,
  p_cards jsonb
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_set public.learning_set;
begin
  if p_cards is null then
    raise exception 'p_cards must not be SQL NULL';
  end if;
  if jsonb_typeof(p_cards) is distinct from 'array' then
    raise exception 'p_cards must be a JSON array';
  end if;
  if jsonb_array_length(p_cards) <> 10 then
    raise exception 'exactly 10 cards are required';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_cards) as item(card)
    where public.trim_flashcard_text(item.card->>'key_text') is null
      or char_length(public.trim_flashcard_text(item.card->>'key_text')) not between 1 and 120
      or not public.is_valid_flashcard_values(item.card->'values')
  ) then raise exception 'invalid card'; end if;
  if (select count(distinct lower(public.trim_flashcard_text(item.card->>'key_text'))) from jsonb_array_elements(p_cards) as item(card)) <> 10 then
    raise exception 'duplicate card key';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_cards) as item(card)
    where jsonb_typeof(item.card->'sort_order') is distinct from 'number'
      or (item.card->>'sort_order') !~ '^([1-9]|10)$'
  ) or (
    select count(distinct (item.card->>'sort_order')::integer)
    from jsonb_array_elements(p_cards) as item(card)
  ) <> 10 then
    raise exception 'sort_order must contain each value from 1 to 10 exactly once';
  end if;

  select * into v_set from public.learning_set where id = p_learning_set_id for update;
  if not found or v_set.status <> 'GENERATING' then raise exception 'learning set is not generating'; end if;
  insert into public.flashcard (learning_set_id, key_text, "values", sort_order)
  select p_learning_set_id, item.card->>'key_text', item.card->'values', (item.card->>'sort_order')::integer
  from jsonb_array_elements(p_cards) as item(card);
  update public.learning_set set title = p_title, status = 'COMPLETED', updated_at = now()
    where id = p_learning_set_id returning * into v_set;
  return to_jsonb(v_set);
end;
$$;
revoke all on function public.complete_learning_set(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.complete_learning_set(uuid, text, jsonb) to service_role;
