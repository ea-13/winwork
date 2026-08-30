import { Router } from 'express';
import type { Role } from 'shared';
import { requireRole } from '../lib/auth.js';
import { supabaseAdmin, supabaseForUser } from '../lib/supabase.js';

export const workspacesRouter = Router();

/**
 * Workspaces — the layer above projects.
 *
 * Tenancy was already real and already tested; what was missing was any way for
 * one person to be in more than one tenant. This is that, and it deliberately
 * changes no RLS policy: switching rewrites the `app_metadata` claims that
 * `current_tenant_id()` has read since 0001, so the isolation guarantee here is
 * exactly the one the isolation suite already proves.
 *
 * The important consequence: a client workspace is isolated from the internal
 * one by the same mechanism that isolates two customers from each other. There
 * is no "internal can see everything" back door, and adding one later would be
 * the moment this stops being safe to hand to a client.
 */

/** Every workspace this person may switch into, current one flagged. */
workspacesRouter.get('/workspaces', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  // Read through the caller's own client: the membership policy is self-only,
  // so this cannot return somebody else's workspaces even by mistake.
  const db = supabaseForUser(auth.token);

  const { data: memberships, error } = await db
    .from('tenant_membership')
    .select('tenant_id, roles, is_owner')
    .order('created_at');

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const tenantIds = (memberships ?? []).map((row) => row.tenant_id as string);

  // Tenant names are fetched with the admin client on purpose: RLS on `tenant`
  // scopes to the ACTIVE tenant, so the caller cannot read the name of a
  // workspace they are not currently in — which is exactly the list we need.
  // Membership above is what authorises it, and only these ids are asked for.
  const { data: tenants } = tenantIds.length
    ? await supabaseAdmin
        .from('tenant')
        .select('id, name, kind, created_at')
        .in('id', tenantIds)
    : { data: [] as Record<string, unknown>[] };

  const byId = new Map((tenants ?? []).map((row) => [row.id as string, row]));

  res.json(
    (memberships ?? []).map((membership) => {
      const tenant = byId.get(membership.tenant_id as string);
      return {
        tenantId: membership.tenant_id,
        name: (tenant?.name as string | null) ?? 'Workspace',
        kind: (tenant?.kind as string | null) ?? 'INTERNAL',
        roles: membership.roles ?? [],
        isOwner: membership.is_owner ?? false,
        isCurrent: membership.tenant_id === auth.tenantId,
      };
    }),
  );
});

/**
 * Creates a workspace and puts the caller in it.
 *
 * ADMIN only, and the caller becomes its owner. A client workspace starts empty
 * — no projects, no subs, no scope — because the point of it is that the
 * client's data is theirs and nothing leaks in from ours.
 */
workspacesRouter.post('/workspaces', requireRole('ADMIN'), async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const kind = body.kind === 'INTERNAL' ? 'INTERNAL' : 'CLIENT';

  if (name === '') {
    res.status(400).json({ error: 'A workspace name is required' });
    return;
  }

  const { data: tenant, error: tenantError } = await supabaseAdmin
    .from('tenant')
    .insert({ name, kind })
    .select('id, name, kind')
    .single();

  if (tenantError || !tenant) {
    res.status(400).json({ error: tenantError?.message ?? 'Could not create the workspace' });
    return;
  }

  // A distinct app_user row per tenant. app_user.id is the auth id only for the
  // person's FIRST workspace; in every other one they are a different row with
  // the same email, which is what the (tenant_id, email) unique key allows.
  const { data: appUser, error: userError } = await supabaseAdmin
    .from('app_user')
    .insert({ tenant_id: tenant.id, email: auth.email, display_name: auth.email })
    .select('id')
    .single();

  if (userError || !appUser) {
    await supabaseAdmin.from('tenant').delete().eq('id', tenant.id);
    res.status(500).json({ error: userError?.message ?? 'Could not create the workspace user' });
    return;
  }

  const roles: Role[] = ['BC', 'EST', 'ADMIN'];

  await supabaseAdmin
    .from('user_role')
    .insert(roles.map((role) => ({ tenant_id: tenant.id, user_id: appUser.id, role })));

  const { error: memberError } = await supabaseAdmin.from('tenant_membership').insert({
    auth_user_id: auth.userId,
    tenant_id: tenant.id,
    app_user_id: appUser.id,
    roles,
    is_owner: true,
  });

  if (memberError) {
    res.status(500).json({ error: memberError.message });
    return;
  }

  await supabaseAdmin.from('audit_event').insert({
    tenant_id: tenant.id,
    actor_id: appUser.id,
    action: 'CREATE_WORKSPACE',
    table_name: 'tenant',
    record_id: tenant.id,
    before: null,
    after: { name, kind },
  });

  res.status(201).json({ tenantId: tenant.id, name: tenant.name, kind: tenant.kind });
});

/**
 * Switches the active workspace.
 *
 * Rewrites `app_metadata` — the claims Supabase copies into the JWT and every
 * RLS policy reads. The client must then refresh its session to pick up the new
 * token; until it does it is still holding the old tenant, which is safe
 * because the old token grants exactly what it granted before.
 *
 * Membership is checked against the table, not against anything the caller
 * sent. This is the one endpoint where getting authorisation wrong would let
 * somebody walk into another tenant, so it reads the row and trusts nothing
 * else.
 */
workspacesRouter.post('/workspaces/:tenantId/switch', async (req, res) => {
  const tenantId = req.params.tenantId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { data: membership } = await supabaseAdmin
    .from('tenant_membership')
    .select('tenant_id, app_user_id, roles')
    .eq('auth_user_id', auth.userId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!membership) {
    // Deliberately the same answer as a workspace that does not exist. Telling
    // somebody a workspace is real but not theirs is telling them it is real.
    res.status(404).json({ error: 'No such workspace' });
    return;
  }

  const { error } = await supabaseAdmin.auth.admin.updateUserById(auth.userId, {
    app_metadata: {
      tenant_id: membership.tenant_id,
      app_user_id: membership.app_user_id,
      roles: membership.roles ?? [],
    },
  });

  if (error) {
    res.status(500).json({ error: `Could not switch workspace: ${error.message}` });
    return;
  }

  res.json({
    tenantId: membership.tenant_id,
    roles: membership.roles ?? [],
    // The client has to act on this: the token in hand still carries the old
    // tenant until the session is refreshed.
    refreshRequired: true,
  });
});
