-- MODU2-only incremental migration. Apply after 202610150002_content_management.sql.
-- Stores provider-reported token usage and an estimate based on the pricing/FX
-- snapshot captured by the server. Existing content remains unlinked (NULL).
alter table public.learning_set
  add column if not exists ai_usage_session_id uuid;

create unique index if not exists learning_set_ai_usage_session_id_uidx
  on public.learning_set (ai_usage_session_id)
  where ai_usage_session_id is not null;

create table if not exists public.ai_usage_event (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  request_id uuid not null,
  operation text not null check (operation in ('suggestions', 'flashcard_generation', 'image_extraction')),
  model text not null check (char_length(model) between 1 and 160),
  input_tokens integer not null check (input_tokens >= 0),
  output_tokens integer not null check (output_tokens >= 0),
  total_tokens integer not null check (total_tokens = input_tokens + output_tokens),
  cached_input_tokens integer not null default 0 check (cached_input_tokens between 0 and input_tokens),
  input_usd_per_million numeric(12, 6),
  cached_input_usd_per_million numeric(12, 6),
  output_usd_per_million numeric(12, 6),
  estimated_usd numeric(20, 12),
  usd_krw_rate numeric(12, 4) not null check (usd_krw_rate > 0),
  estimated_krw numeric(20, 8),
  pricing_as_of date not null,
  fx_rate_as_of date not null,
  fx_rate_source text not null,
  created_at timestamptz not null default now(),
  check ((estimated_usd is null) = (estimated_krw is null))
);

create index if not exists ai_usage_event_session_idx
  on public.ai_usage_event (session_id, created_at);

alter table public.ai_usage_event enable row level security;
revoke all on table public.ai_usage_event from public, anon, authenticated;
grant select, insert on table public.ai_usage_event to service_role;

-- Bind each usage session to at most one authenticated owner. Anonymous preview
-- sessions remain unclaimed until saved by a logged-in user.
create table if not exists public.ai_usage_session_claim (
  session_id uuid primary key,
  -- Retain the verified owner UUID even if the Auth user is deleted. Deleting
  -- this claim would let a still-valid signed session token be claimed again.
  owner_id uuid not null,
  claimed_at timestamptz not null default now()
);
alter table public.ai_usage_session_claim enable row level security;
revoke all on table public.ai_usage_session_claim from public, anon, authenticated;
grant select, insert on table public.ai_usage_session_claim to service_role;

create or replace function public.claim_ai_usage_session(p_session_id uuid, p_owner_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog
as $$
declare v_owner_id uuid;
begin
  if p_session_id is null or p_owner_id is null then raise exception 'usage session and owner are required'; end if;
  insert into public.ai_usage_session_claim (session_id, owner_id)
    values (p_session_id, p_owner_id) on conflict (session_id) do nothing;
  select owner_id into v_owner_id from public.ai_usage_session_claim where session_id = p_session_id;
  if v_owner_id is distinct from p_owner_id then raise exception 'usage session belongs to another user'; end if;
end;
$$;
revoke all on function public.claim_ai_usage_session(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_ai_usage_session(uuid, uuid) to service_role;

create or replace function public.record_ai_usage_event(
  p_session_id uuid, p_request_id uuid, p_operation text, p_model text,
  p_input_tokens integer, p_output_tokens integer, p_total_tokens integer, p_cached_input_tokens integer,
  p_input_usd_per_million numeric, p_cached_input_usd_per_million numeric, p_output_usd_per_million numeric,
  p_estimated_usd numeric, p_usd_krw_rate numeric, p_estimated_krw numeric,
  p_pricing_as_of date, p_fx_rate_as_of date, p_fx_rate_source text, p_owner_id uuid default null
) returns void language plpgsql security definer set search_path = pg_catalog
as $$
begin
  if p_owner_id is null then
    if exists (select 1 from public.ai_usage_session_claim where session_id = p_session_id) then
      raise exception 'usage session requires its owner';
    end if;
  else
    perform public.claim_ai_usage_session(p_session_id, p_owner_id);
  end if;
  insert into public.ai_usage_event (session_id, request_id, operation, model, input_tokens, output_tokens,
    total_tokens, cached_input_tokens, input_usd_per_million, cached_input_usd_per_million,
    output_usd_per_million, estimated_usd, usd_krw_rate, estimated_krw, pricing_as_of,
    fx_rate_as_of, fx_rate_source)
  values (p_session_id, p_request_id, p_operation, p_model, p_input_tokens, p_output_tokens,
    p_total_tokens, p_cached_input_tokens, p_input_usd_per_million, p_cached_input_usd_per_million,
    p_output_usd_per_million, p_estimated_usd, p_usd_krw_rate, p_estimated_krw,
    p_pricing_as_of, p_fx_rate_as_of, p_fx_rate_source);
end;
$$;
revoke all on function public.record_ai_usage_event(uuid, uuid, text, text, integer, integer, integer, integer, numeric, numeric, numeric, numeric, numeric, numeric, date, date, text, uuid) from public, anon, authenticated;
grant execute on function public.record_ai_usage_event(uuid, uuid, text, text, integer, integer, integer, integer, numeric, numeric, numeric, numeric, numeric, numeric, date, date, text, uuid) to service_role;

-- A service-role-only link lets a guest preview or photo extraction retain its
-- measured usage until the user saves that content. Ownership is checked in SQL.
create or replace function public.attach_ai_usage_session(
  p_learning_set_id uuid, p_owner_id uuid, p_session_id uuid
) returns void language plpgsql security definer set search_path = pg_catalog
as $$
begin
  if p_session_id is null then raise exception 'AI usage session is required'; end if;
  perform public.claim_ai_usage_session(p_session_id, p_owner_id);
  update public.learning_set
  set ai_usage_session_id = p_session_id
  where id = p_learning_set_id and owner_id = p_owner_id and status = 'COMPLETED'
    and source_mode in ('AI', 'PHOTO') and ai_usage_session_id is null;
  if not found then raise exception 'content not found, not owned, or already linked'; end if;
end;
$$;
revoke all on function public.attach_ai_usage_session(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.attach_ai_usage_session(uuid, uuid, uuid) to service_role;

-- Add an optional aggregate to the existing paginated listing RPC. All token
-- fields retain the provider's input/output breakdown; costs are estimates only.
create or replace function public.list_learning_sets(
  p_query text default '', p_sort text default 'newest', p_page integer default 1,
  p_page_size integer default 20, p_owner_id uuid default null, p_scope text default 'all'
) returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare
  v_result jsonb;
  v_total integer;
  v_page integer := greatest(1, coalesce(p_page, 1));
  v_size integer := greatest(1, least(coalesce(p_page_size, 20), 50));
  v_sort text := case when p_sort = 'name' then 'name' else 'newest' end;
  v_query text := lower(btrim(coalesce(p_query, '')));
begin
  if p_scope is null or p_scope not in ('all', 'mine') then raise exception 'invalid scope'; end if;
  if p_scope = 'mine' and p_owner_id is null then raise exception 'owner required'; end if;
  select count(*)::integer into v_total from public.learning_set ls
  where ls.status = 'COMPLETED' and (p_scope <> 'mine' or ls.owner_id = p_owner_id)
    and (v_query = '' or position(v_query in lower(ls.title || ' ' || ls.original_request)) > 0
      or exists (select 1 from public.flashcard fc where fc.learning_set_id = ls.id
        and position(v_query in lower(fc.key_text || ' ' || coalesce(fc."values"::text, ''))) > 0));
  select coalesce(jsonb_agg(item.row_data order by case when v_sort = 'name' then item.sort_name end asc,
    case when v_sort = 'newest' then item.sort_created end desc, item.row_id), '[]'::jsonb)
    into v_result
  from (
    select ls.id as row_id, lower(ls.title) as sort_name, ls.created_at as sort_created,
      jsonb_build_object('id', ls.id, 'title', ls.title, 'original_request', ls.original_request,
        'created_at', ls.created_at, 'updated_at', ls.updated_at, 'source_mode', ls.source_mode,
        'card_count', (select count(*)::integer from public.flashcard fc where fc.learning_set_id = ls.id),
        'preview', coalesce((select jsonb_agg(jsonb_build_object('key', sample.key_text, 'values', sample."values") order by sample.sort_order)
          from (select fc.key_text, fc."values", fc.sort_order from public.flashcard fc
            where fc.learning_set_id = ls.id order by fc.sort_order limit 2) sample), '[]'::jsonb),
        'can_edit', p_owner_id is not null and ls.owner_id = p_owner_id,
        'ai_usage', (select jsonb_build_object(
          'input_tokens', sum(e.input_tokens)::bigint,
          'output_tokens', sum(e.output_tokens)::bigint,
          'total_tokens', sum(e.total_tokens)::bigint,
          'cached_input_tokens', sum(e.cached_input_tokens)::bigint,
          'estimated_usd', case when bool_and(e.estimated_usd is not null) then sum(e.estimated_usd) else null end,
          'estimated_krw', case when bool_and(e.estimated_krw is not null) then sum(e.estimated_krw) else null end,
          'models', to_jsonb(array_agg(distinct e.model)),
          'operations', to_jsonb(array_agg(distinct e.operation)),
          'pricing_as_of', to_jsonb(array_agg(distinct e.pricing_as_of::text)),
          'fx_rate_as_of', to_jsonb(array_agg(distinct e.fx_rate_as_of::text)),
          'fx_rate_source', to_jsonb(array_agg(distinct e.fx_rate_source)),
          'model_rates', jsonb_agg(distinct jsonb_build_object('model', e.model,
            'input_usd_per_million', e.input_usd_per_million,
            'cached_input_usd_per_million', e.cached_input_usd_per_million,
            'output_usd_per_million', e.output_usd_per_million,
            'pricing_as_of', e.pricing_as_of::text)),
          'fx_rates', jsonb_agg(distinct jsonb_build_object('usd_krw_rate', e.usd_krw_rate,
            'as_of', e.fx_rate_as_of::text, 'source', e.fx_rate_source)))
          from public.ai_usage_event e where e.session_id = ls.ai_usage_session_id
          having count(*) > 0)
      ) as row_data
    from public.learning_set ls
    where ls.status = 'COMPLETED' and (p_scope <> 'mine' or ls.owner_id = p_owner_id)
      and (v_query = '' or position(v_query in lower(ls.title || ' ' || ls.original_request)) > 0
        or exists (select 1 from public.flashcard fc where fc.learning_set_id = ls.id
          and position(v_query in lower(fc.key_text || ' ' || coalesce(fc."values"::text, ''))) > 0))
    order by case when v_sort = 'name' then lower(ls.title) else '' end asc,
      case when v_sort = 'newest' then ls.created_at end desc, ls.id
    offset (v_page - 1) * v_size limit v_size
  ) item;
  return jsonb_build_object('results', v_result, 'total', v_total, 'page', v_page,
    'page_size', v_size, 'total_pages', greatest(1, ceil(v_total::numeric / v_size)::integer));
end;
$$;
revoke all on function public.list_learning_sets(text, text, integer, integer, uuid, text) from public, anon, authenticated;
grant execute on function public.list_learning_sets(text, text, integer, integer, uuid, text) to service_role;
