import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '../lib/api';
import { supabase } from '../lib/supabase';

type Workspace = {
  tenantId: string;
  name: string;
  kind: 'INTERNAL' | 'CLIENT';
  roles: string[];
  isOwner: boolean;
  isCurrent: boolean;
};

/**
 * The workspace you are in, and the ones you can move to.
 *
 * A workspace is a tenant, and tenants have been genuinely isolated since the
 * first migration — the same mechanism that keeps two customers apart is what
 * keeps a client workspace apart from the internal one. There is no "internal
 * sees everything" view, on purpose: the day that exists is the day this stops
 * being safe to hand to a client.
 *
 * Switching rewrites the JWT claims server-side, so the session has to be
 * refreshed before anything is fetched again. Doing that wrong would leave the
 * browser showing one workspace's name over another workspace's data, which is
 * the worst possible failure here — so the reload is unconditional rather than
 * clever.
 */
export function WorkspaceSwitcher() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      setWorkspaces(await apiGet<Workspace[]>('/workspaces'));
    } catch {
      setWorkspaces([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const current = workspaces.find((workspace) => workspace.isCurrent);

  const switchTo = async (workspace: Workspace) => {
    if (workspace.isCurrent) {
      setOpen(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/workspaces/${workspace.tenantId}/switch`);

      // The token in hand still carries the old tenant. Refresh, then go to the
      // project list — staying on a deep link would mean requesting a row from
      // the workspace we just left, which correctly 404s and reads as a bug.
      await supabase.auth.refreshSession();
      navigate('/');
      window.location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  };

  const create = async () => {
    if (name.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const created = await apiPost<{ tenantId: string }>('/workspaces', {
        name: name.trim(),
        kind: 'CLIENT',
      });
      setName('');
      setCreating(false);
      await load();
      await switchTo({
        tenantId: created.tenantId,
        name: name.trim(),
        kind: 'CLIENT',
        roles: [],
        isOwner: true,
        isCurrent: false,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-ink-700 hover:bg-ink-100"
        title="Switch workspace"
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            current?.kind === 'CLIENT' ? 'bg-flag-500' : 'bg-ink-400'
          }`}
        />
        <span className="max-w-[12rem] truncate font-medium">{current?.name ?? 'Workspace'}</span>
        <span className="text-ink-300">▾</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-40 mt-1 w-72 rounded-lg border border-ink-200 bg-white py-1 shadow-lg">
            <p className="px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-ink-400">
              Workspaces
            </p>

            {workspaces.map((workspace) => (
              <button
                key={workspace.tenantId}
                disabled={busy}
                onClick={() => void switchTo(workspace)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-ink-50 disabled:opacity-50 ${
                  workspace.isCurrent ? 'bg-ink-50' : ''
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    workspace.kind === 'CLIENT' ? 'bg-flag-500' : 'bg-ink-400'
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ink-900">{workspace.name}</span>
                  <span className="block text-[10px] text-ink-400">
                    {workspace.kind === 'CLIENT' ? 'client' : 'internal'}
                    {workspace.roles.length > 0 && ` · ${workspace.roles.join(', ')}`}
                  </span>
                </span>
                {workspace.isCurrent && <span className="text-[10px] text-ink-400">current</span>}
              </button>
            ))}

            <div className="mt-1 border-t border-ink-100 pt-1">
              {creating ? (
                <div className="flex items-center gap-1 px-2 py-1">
                  <input
                    autoFocus
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void create();
                      if (event.key === 'Escape') setCreating(false);
                    }}
                    placeholder="Client name"
                    className="min-w-0 flex-1 rounded border border-ink-300 px-2 py-1 text-xs outline-none focus:border-ink-800"
                  />
                  <button
                    disabled={busy || name.trim() === ''}
                    onClick={() => void create()}
                    className="rounded bg-ink-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
                  >
                    {busy ? '…' : 'Create'}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setCreating(true)}
                  className="w-full px-3 py-1.5 text-left text-xs text-ink-500 hover:bg-ink-50"
                >
                  + New client workspace
                </button>
              )}
            </div>

            {error && <p className="px-3 py-1.5 text-[11px] text-red-600">{error}</p>}

            <p className="border-t border-ink-100 px-3 pb-1 pt-1.5 text-[10px] leading-snug text-ink-400">
              Each workspace is fully isolated. Nothing crosses between them, including
              for you.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
