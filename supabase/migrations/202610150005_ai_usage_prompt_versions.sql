-- MODU2-only additive migration. Apply after 202610150004_ai_prompt_management.sql.
-- Historical events receive an explicit unknown attribution. No usage or content
-- rows are rewritten, and new prompt fields remain nullable for legacy callers.
begin;

alter table public.ai_usage_event
  add column if not exists prompt_key text,
  add column if not exists prompt_version_id uuid,
  add column if not exists prompt_version_number integer,
  add column if not exists prompt_source text not null default 'unknown';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_usage_event_prompt_key_check'
    and conrelid = 'public.ai_usage_event'::regclass) then
    alter table public.ai_usage_event add constraint ai_usage_event_prompt_key_check
      check (prompt_key is null or prompt_key in ('RECOMMEND', 'FLASHCARD', 'IMAGE_EXTRACTION'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_usage_event_prompt_version_number_check'
    and conrelid = 'public.ai_usage_event'::regclass) then
    alter table public.ai_usage_event add constraint ai_usage_event_prompt_version_number_check
      check (prompt_version_number is null or prompt_version_number > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_usage_event_prompt_source_check'
    and conrelid = 'public.ai_usage_event'::regclass) then
    alter table public.ai_usage_event add constraint ai_usage_event_prompt_source_check
      check (prompt_source in ('active', 'fallback', 'code', 'unknown'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_usage_event_prompt_version_fk'
    and conrelid = 'public.ai_usage_event'::regclass) then
    alter table public.ai_usage_event add constraint ai_usage_event_prompt_version_fk
      foreign key (prompt_version_id) references public.ai_prompt_version(id) on delete set null;
  end if;
end;
$$;

create index if not exists ai_usage_event_prompt_version_idx
  on public.ai_usage_event (prompt_version_id) where prompt_version_id is not null;

-- Keep the original service-role-only overload for older server instances.
-- New code calls this extended overload and records the exact prompt snapshot.
create or replace function public.record_ai_usage_event(
  p_session_id uuid, p_request_id uuid, p_operation text, p_model text,
  p_input_tokens integer, p_output_tokens integer, p_total_tokens integer, p_cached_input_tokens integer,
  p_input_usd_per_million numeric, p_cached_input_usd_per_million numeric, p_output_usd_per_million numeric,
  p_estimated_usd numeric, p_usd_krw_rate numeric, p_estimated_krw numeric,
  p_pricing_as_of date, p_fx_rate_as_of date, p_fx_rate_source text, p_owner_id uuid,
  p_prompt_key text, p_prompt_version_id uuid, p_prompt_version_number integer, p_prompt_source text
) returns void language plpgsql security definer set search_path = pg_catalog
as $$
begin
  if p_prompt_key is not null and p_prompt_key not in ('RECOMMEND', 'FLASHCARD', 'IMAGE_EXTRACTION') then
    raise exception 'invalid prompt key';
  end if;
  if p_prompt_source not in ('active', 'fallback', 'code', 'unknown') then raise exception 'invalid prompt source'; end if;
  if p_prompt_source = 'active' and p_prompt_version_id is null then raise exception 'active prompt version is required'; end if;
  if p_prompt_source in ('fallback', 'code') and p_prompt_version_id is not null then raise exception 'non-active prompt cannot reference a managed version'; end if;
  if p_prompt_version_id is not null then
    if p_prompt_key not in ('RECOMMEND', 'FLASHCARD') or p_prompt_version_number is null then
      raise exception 'prompt version metadata is incomplete';
    end if;
    if not exists (select 1 from public.ai_prompt_version v join public.ai_prompt_template t on t.id = v.template_id
      where v.id = p_prompt_version_id and v.version_number = p_prompt_version_number
        and t.prompt_key = p_prompt_key) then raise exception 'prompt version metadata does not match'; end if;
  elsif p_prompt_version_number is not null then raise exception 'prompt version id is required';
  end if;

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
    fx_rate_as_of, fx_rate_source, prompt_key, prompt_version_id, prompt_version_number, prompt_source)
  values (p_session_id, p_request_id, p_operation, p_model, p_input_tokens, p_output_tokens,
    p_total_tokens, p_cached_input_tokens, p_input_usd_per_million, p_cached_input_usd_per_million,
    p_output_usd_per_million, p_estimated_usd, p_usd_krw_rate, p_estimated_krw,
    p_pricing_as_of, p_fx_rate_as_of, p_fx_rate_source, p_prompt_key, p_prompt_version_id,
    p_prompt_version_number, p_prompt_source);
end;
$$;
revoke all on function public.record_ai_usage_event(uuid, uuid, text, text, integer, integer, integer, integer,
  numeric, numeric, numeric, numeric, numeric, numeric, date, date, text, uuid, text, uuid, integer, text)
  from public, anon, authenticated;
grant execute on function public.record_ai_usage_event(uuid, uuid, text, text, integer, integer, integer, integer,
  numeric, numeric, numeric, numeric, numeric, numeric, date, date, text, uuid, text, uuid, integer, text) to service_role;

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
            'as_of', e.fx_rate_as_of::text, 'source', e.fx_rate_source)),
          'by_operation', (select jsonb_agg(jsonb_build_object(
            'operation', op_summary.operation, 'input_tokens', op_summary.input_tokens,
            'output_tokens', op_summary.output_tokens, 'total_tokens', op_summary.total_tokens,
            'cached_input_tokens', op_summary.cached_input_tokens,
            'estimated_usd', op_summary.estimated_usd, 'estimated_krw', op_summary.estimated_krw,
            'prompt_key', op_summary.prompt_key, 'prompt_version_id', op_summary.prompt_version_id,
            'prompt_version_number', op_summary.prompt_version_number, 'prompt_source', op_summary.prompt_source,
            'models', op_summary.models, 'model_rates', op_summary.model_rates, 'fx_rates', op_summary.fx_rates))
            from (select e2.operation, e2.prompt_key, e2.prompt_version_id, e2.prompt_version_number, e2.prompt_source,
              sum(e2.input_tokens)::bigint as input_tokens, sum(e2.output_tokens)::bigint as output_tokens,
              sum(e2.total_tokens)::bigint as total_tokens, sum(e2.cached_input_tokens)::bigint as cached_input_tokens,
              case when bool_and(e2.estimated_usd is not null) then sum(e2.estimated_usd) else null end as estimated_usd,
              case when bool_and(e2.estimated_krw is not null) then sum(e2.estimated_krw) else null end as estimated_krw,
              to_jsonb(array_agg(distinct e2.model)) as models,
              jsonb_agg(distinct jsonb_build_object('model', e2.model, 'input_usd_per_million', e2.input_usd_per_million,
                'cached_input_usd_per_million', e2.cached_input_usd_per_million,
                'output_usd_per_million', e2.output_usd_per_million, 'pricing_as_of', e2.pricing_as_of::text)) as model_rates,
              jsonb_agg(distinct jsonb_build_object('usd_krw_rate', e2.usd_krw_rate,
                'as_of', e2.fx_rate_as_of::text, 'source', e2.fx_rate_source)) as fx_rates
              from public.ai_usage_event e2 where e2.session_id = ls.ai_usage_session_id
              group by e2.operation, e2.prompt_key, e2.prompt_version_id, e2.prompt_version_number, e2.prompt_source) op_summary))
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

commit;
