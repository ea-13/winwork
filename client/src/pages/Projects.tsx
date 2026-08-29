import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ErrorBanner, Layout } from '../components/Layout';
import { apiGet, apiPost } from '../lib/api';

export type Project = {
  id: string;
  bid_id: string;
  name: string;
  owner_org: string | null;
  due_at: string | null;
  status: string | null;
};

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', bidId: '', ownerOrg: '', dueAt: '' });

  const load = () =>
    apiGet<Project[]>('/projects')
      .then(setProjects)
      .catch((caught: Error) => setError(caught.message));

  useEffect(() => {
    void load();
  }, []);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiPost<Project>('/projects', {
        name: form.name,
        bidId: form.bidId.toUpperCase(),
        ownerOrg: form.ownerOrg || undefined,
        dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : undefined,
      });
      setForm({ name: '', bidId: '', ownerOrg: '', dueAt: '' });
      setOpen(false);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Layout>
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Projects</h1>
        <button
          onClick={() => setOpen((value) => !value)}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
        >
          {open ? 'Cancel' : 'New project'}
        </button>
      </div>

      <ErrorBanner message={error} />

      {open && (
        <form onSubmit={create} className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Name</span>
            <input
              required
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="Riverside Medical Office TI"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-slate-700">Bid ID</span>
            <input
              required
              value={form.bidId}
              onChange={(event) => setForm({ ...form, bidId: event.target.value })}
              placeholder="RMO-2026-004"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm uppercase outline-none focus:border-slate-900"
            />
            <span className="mt-1 block text-xs text-slate-500">
              PREFIX-YYYY-NNN. Permanent, never reused.
            </span>
          </label>

          <label className="block">
            <span className="text-sm font-medium text-slate-700">Owner</span>
            <input
              value={form.ownerOrg}
              onChange={(event) => setForm({ ...form, ownerOrg: event.target.value })}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-slate-700">Bid due</span>
            <input
              type="date"
              value={form.dueAt}
              onChange={(event) => setForm({ ...form, dueAt: event.target.value })}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900"
            />
          </label>

          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create project'}
            </button>
          </div>
        </form>
      )}

      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-2 font-medium">Bid ID</th>
              <th className="px-4 py-2 font-medium">Project</th>
              <th className="px-4 py-2 font-medium">Owner</th>
              <th className="px-4 py-2 font-medium">Due</th>
              <th className="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => (
              <tr key={project.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2 font-mono text-xs text-slate-500">{project.bid_id}</td>
                <td className="px-4 py-2">
                  <Link to={`/projects/${project.id}`} className="font-medium text-slate-900 underline">
                    {project.name}
                  </Link>
                </td>
                <td className="px-4 py-2 text-slate-600">{project.owner_org ?? '—'}</td>
                <td className="px-4 py-2 text-slate-600">
                  {project.due_at ? new Date(project.due_at).toLocaleDateString() : '—'}
                </td>
                <td className="px-4 py-2">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                    {project.status ?? '—'}
                  </span>
                </td>
              </tr>
            ))}
            {projects.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-sm text-slate-400">
                  No projects yet. Create one, or run <code>npm run seed</code> for the demo tenant.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </Layout>
  );
}
