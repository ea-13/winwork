-- =============================================================================
-- 0016 · Workspaces — one person, several tenants
--
-- Tenancy has been real since 0001: every table carries tenant_id, every policy
-- checks it, and the isolation suite proves a caller cannot read another
-- tenant's rows. What did not exist was any way for ONE person to belong to
-- more than one of them.
--
-- The blocker was an identity assumption, not a security one. `app_user.id` IS
-- the Supabase Auth user id, so a person could only ever have one app_user row,
-- and therefore only one tenant. That was the right shape for a single internal
-- team and the wrong shape the moment Elie wants a client to have their own
-- space he can hand over later.
--
-- So: a membership table keyed on the AUTH user, pointing at one app_user row
-- per tenant. Switching workspace rewrites the app_metadata claims that
-- current_tenant_id() already reads, which means not one RLS policy changes.
-- The isolation guarantee is exactly the one that was already tested.
--
-- What this is NOT: an invitation or sharing system. A client cannot yet be
-- given a login. This is the layer that makes that possible without a rewrite.
-- =============================================================================

create table public.tenant_membership (
  id            uuid primary key default gen_random_uuid(),
  -- The Supabase Auth user. Deliberately not a foreign key into app_user: the
  -- whole point is that one auth identity spans several app_user rows.
  auth_user_id  uuid not null,
  tenant_id     uuid not null references public.tenant(id) on delete cascade,
  -- The app_user row this person is, inside that tenant.
  app_user_id   uuid not null references public.app_user(id) on delete cascade,
  roles         text[] not null default '{}',
  -- Who owns the relationship, for when this becomes real sharing.
  is_owner      boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (auth_user_id, tenant_id)
);

create index idx_tenant_membership_auth_user on public.tenant_membership (auth_user_id);
create index idx_tenant_membership_tenant on public.tenant_membership (tenant_id);

alter table public.tenant_membership enable row level security;

-- A person may read their OWN memberships, and nothing else. Note this policy
-- is not tenant-scoped, and cannot be: the whole purpose of the row is to be
-- readable while a different tenant is active, so the switcher can list the
-- workspaces you are not currently in.
create policy own_memberships on public.tenant_membership
  for select to authenticated
  using (auth_user_id = auth.uid());

-- Writes go through service_role only. Granting a person a workspace is not
-- something a browser session does to itself.
comment on table public.tenant_membership is
  'Which workspaces an auth user may switch into. SELECT is self-only; all '
  'writes are service_role, because self-granting access is the one thing this '
  'table must never permit.';


-- -----------------------------------------------------------------------------
-- Naming a workspace
-- -----------------------------------------------------------------------------

-- tenant already carries created_at from 0001; only kind is new.
alter table public.tenant
  add column kind text not null default 'INTERNAL'
    check (kind in ('INTERNAL','CLIENT'));

comment on column public.tenant.kind is
  'INTERNAL is our own workspace. CLIENT is one created on behalf of a customer '
  'and intended to be handed to them later.';


-- -----------------------------------------------------------------------------
-- Backfill: everybody who exists now keeps working
-- -----------------------------------------------------------------------------

insert into public.tenant_membership (auth_user_id, tenant_id, app_user_id, roles, is_owner)
select
  au.id,
  au.tenant_id,
  au.id,
  coalesce(
    (select array_agg(ur.role) from public.user_role ur where ur.user_id = au.id),
    '{}'
  ),
  true
from public.app_user au
on conflict (auth_user_id, tenant_id) do nothing;
