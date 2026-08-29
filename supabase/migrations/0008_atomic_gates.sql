-- =============================================================================
-- 0008 · Atomic gate crossings
--
-- Until now each gate wrote its approval row and performed its state change as
-- two separate statements, because supabase-js cannot span a transaction. The
-- approval was written first, so a failure between them left an approval
-- recording an attempt that did not land -- visible and honest, but not exact.
--
-- The approval ledger is this product's integrity claim to a general
-- contractor. "We can prove who approved what" has to be true without an
-- asterisk, so each gate is now one function and one transaction: either the
-- approval and the change both happen, or neither does.
--
-- SECURITY INVOKER, so RLS still decides which rows the caller can touch. A
-- gate function is not a way around tenancy.
-- =============================================================================


-- H2 · Scope of Work locked — EST
create or replace function public.gate_h2_scope_lock(
  p_actor_role   text,
  p_rationale    text,
  p_scope_items  uuid[]
)
returns json
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_actor    uuid := auth.uid();
  v_approval uuid;
  v_count    int;
begin
  if coalesce(trim(p_rationale), '') = '' then
    raise exception 'A non-empty rationale is required to cross a gate'
      using errcode = '22023';
  end if;

  insert into public.approval (tenant_id, gate, actor_id, actor_role, rationale)
  values (v_tenant, 'H2', v_actor, p_actor_role, p_rationale)
  returning id into v_approval;

  update public.scope_item
     set is_locked = true, locked_by = v_actor, locked_at = now()
   where id = any(p_scope_items);

  get diagnostics v_count = row_count;
  return json_build_object('approvalId', v_approval, 'affected', v_count);
end;
$$;


-- H3 · Work package approved — BC
create or replace function public.gate_h3_package_approve(
  p_actor_role text,
  p_rationale  text,
  p_package    uuid
)
returns json
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_actor    uuid := auth.uid();
  v_approval uuid;
  v_count    int;
begin
  if coalesce(trim(p_rationale), '') = '' then
    raise exception 'A non-empty rationale is required to cross a gate'
      using errcode = '22023';
  end if;

  insert into public.approval (tenant_id, gate, actor_id, actor_role, rationale)
  values (v_tenant, 'H3', v_actor, p_actor_role, p_rationale)
  returning id into v_approval;

  update public.work_package
     set status = 'APPROVED', approved_by = v_actor, approved_at = now()
   where id = p_package;

  get diagnostics v_count = row_count;
  return json_build_object('approvalId', v_approval, 'affected', v_count);
end;
$$;


-- H4 · Bidder list approved — BC
create or replace function public.gate_h4_bidder_list_approve(
  p_actor_role text,
  p_rationale  text,
  p_package    uuid
)
returns json
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_actor    uuid := auth.uid();
  v_approval uuid;
  v_count    int;
begin
  if coalesce(trim(p_rationale), '') = '' then
    raise exception 'A non-empty rationale is required to cross a gate'
      using errcode = '22023';
  end if;

  insert into public.approval (tenant_id, gate, actor_id, actor_role, rationale)
  values (v_tenant, 'H4', v_actor, p_actor_role, p_rationale)
  returning id into v_approval;

  update public.package_bidder
     set list_approved_by = v_actor, list_approved_at = now()
   where package_id = p_package;

  get diagnostics v_count = row_count;
  return json_build_object('approvalId', v_approval, 'affected', v_count);
end;
$$;


-- H5 · Clarifications released — EST. Drafted only; there is no send (R3).
create or replace function public.gate_h5_clarifications(
  p_actor_role text,
  p_rationale  text,
  p_package    uuid
)
returns json
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_actor    uuid := auth.uid();
  v_approval uuid;
  v_count    int;
begin
  if coalesce(trim(p_rationale), '') = '' then
    raise exception 'A non-empty rationale is required to cross a gate'
      using errcode = '22023';
  end if;

  insert into public.approval (tenant_id, gate, actor_id, actor_role, rationale)
  values (v_tenant, 'H5', v_actor, p_actor_role, p_rationale)
  returning id into v_approval;

  update public.solicitation_draft
     set approved_by = v_actor, approved_at = now()
   where package_id = p_package;

  get diagnostics v_count = row_count;
  return json_build_object('approvalId', v_approval, 'affected', v_count);
end;
$$;


-- H6 · Bidder selected — EST. A selection is a record, not a notification.
create or replace function public.gate_h6_selection(
  p_actor_role text,
  p_rationale  text,
  p_package    uuid,
  p_quote      uuid
)
returns json
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_actor    uuid := auth.uid();
  v_approval uuid;
begin
  if coalesce(trim(p_rationale), '') = '' then
    raise exception 'A non-empty rationale is required to cross a gate'
      using errcode = '22023';
  end if;

  insert into public.approval (tenant_id, gate, actor_id, actor_role, rationale)
  values (v_tenant, 'H6', v_actor, p_actor_role, p_rationale)
  returning id into v_approval;

  insert into public.selection (tenant_id, package_id, quote_id, selected_by, rationale)
  values (v_tenant, p_package, p_quote, v_actor, p_rationale);

  return json_build_object('approvalId', v_approval, 'affected', 1);
end;
$$;


grant execute on function public.gate_h2_scope_lock(text, text, uuid[]) to authenticated;
grant execute on function public.gate_h3_package_approve(text, text, uuid) to authenticated;
grant execute on function public.gate_h4_bidder_list_approve(text, text, uuid) to authenticated;
grant execute on function public.gate_h5_clarifications(text, text, uuid) to authenticated;
grant execute on function public.gate_h6_selection(text, text, uuid, uuid) to authenticated;
