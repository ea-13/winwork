import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorBanner, Layout } from '../components/Layout';
import { apiGet, apiPost } from '../lib/api';
import { supabase } from '../lib/supabase';

type Sub = {
  id: string;
  name: string;
  trade_csi: string[] | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  prequal_status: string | null;
  emr: number | null;
  city: string | null;
  state: string | null;
};

type ParsedRow = {
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  scopeText: string | null;
  divisions: string[];
  skipReason: string | null;
  raw: Record<string, unknown>;
};

type Preview = {
  filename: string;
  sourceKind: string;
  sheetNames: string[];
  rowCount: number;
  importable: number;
  skipped: number;
  classified: number;
  unmatchedScopes: string[];
  rows: ParsedRow[];
  truncated: boolean;
};

type Division = { code: string; title: string };

/**
 * P15 · Sub list, and the import review.
 *
 * Nothing is written until a human has seen what would be written. A vendor
 * master carries thousands of rows and no trade column, and a silent import of
 * that is not an import, it is a spill.
 */
export function SubsPage() {
  const [subs, setSubs] = useState<Sub[]>([]);
  const [coverage, setCoverage] = useState<Record<string, number>>({});
  const [unclassified, setUnclassified] = useState(0);
  const [divisions, setDivisions] = useState<Division[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [assign, setAssign] = useState<Record<number, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const [list, divs] = await Promise.all([
      apiGet<{ rows: Sub[]; coverage: Record<string, number>; unclassified: number }>(
        '/subcontractors',
      ),
      apiGet<Division[]>('/divisions'),
    ]);
    setSubs(list.rows);
    setCoverage(list.coverage);
    setUnclassified(list.unclassified);
    setDivisions(divs);
  }, []);

  useEffect(() => {
    load().catch((caught: Error) => setError(caught.message));
  }, [load]);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const { data } = await supabase.auth.getSession();

      const response = await fetch('/api/subcontractors/import/preview', {
        method: 'POST',
        headers: { Authorization: `Bearer ${data.session?.access_token ?? ''}` },
        body: form,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Preview failed');
      setPreview(body as Preview);
      setAssign({});
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const rows = preview.rows
        .map((row, index) => ({ ...row, divisions: assign[index] ?? row.divisions }))
        .filter((row) => !row.skipReason);

      const result = await apiPost<{ imported: number; offered: number }>(
        '/subcontractors/import/commit',
        { rows, filename: preview.filename, sourceKind: preview.sourceKind },
      );
      setPreview(null);
      await load();
      setError(`Imported ${result.imported} of ${result.offered} rows.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const missingDivisions = divisions.filter((division) => !coverage[division.code]);

  return (
    <Layout breadcrumb={<span>Subcontractors</span>}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Subcontractors</h1>
          <p className="text-sm text-slate-500">
            {subs.length} on the list · {unclassified} with no trade assigned
          </p>
        </div>
        <button
          onClick={() => picker.current?.click()}
          disabled={busy}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          Import a list
        </button>
        <input
          ref={picker}
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
            event.target.value = '';
          }}
        />
      </div>

      <ErrorBanner message={error} />

      {missingDivisions.length > 0 && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          No qualified subs for {missingDivisions.length} division
          {missingDivisions.length === 1 ? '' : 's'}:{' '}
          {missingDivisions.slice(0, 8).map((d) => d.code).join(', ')}
          {missingDivisions.length > 8 && '…'}
        </p>
      )}

      {preview && (
        <section className="space-y-3 rounded-lg border border-slate-300 bg-white p-4">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-sm font-medium text-slate-900">
                Review before importing — {preview.filename}
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Read as <strong>{preview.sourceKind.replace('_', ' ').toLowerCase()}</strong> ·{' '}
                {preview.rowCount} rows · {preview.importable} importable · {preview.skipped} skipped
                · <strong>{preview.classified} trade-classified</strong>
              </p>
              {preview.classified < preview.importable && (
                <p className="mt-1 text-xs text-amber-700">
                  {preview.importable - preview.classified} rows have no trade. They import
                  unclassified rather than guessed — assign below, or later.
                </p>
              )}
            </div>
            <div className="flex gap-2">
              <button onClick={() => setPreview(null)} className="text-xs text-slate-500 underline">
                cancel
              </button>
              <button
                onClick={() => void commit()}
                disabled={busy}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                Import {preview.importable}
              </button>
            </div>
          </div>

          <div className="max-h-80 overflow-auto rounded border border-slate-200">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-50">
                <tr className="text-left text-slate-500">
                  <th className="px-2 py-1.5 font-medium">Company</th>
                  <th className="px-2 py-1.5 font-medium">Their words</th>
                  <th className="px-2 py-1.5 font-medium">Divisions</th>
                  <th className="px-2 py-1.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, 200).map((row, index) => (
                  <tr key={index} className="border-t border-slate-100">
                    <td className="px-2 py-1 text-slate-800">{row.name}</td>
                    <td className="px-2 py-1 text-slate-500">{row.scopeText ?? '—'}</td>
                    <td className="px-2 py-1">
                      <input
                        value={(assign[index] ?? row.divisions).join(', ')}
                        onChange={(event) =>
                          setAssign({
                            ...assign,
                            [index]: event.target.value
                              .split(',')
                              .map((part) => part.trim())
                              .filter(Boolean),
                          })
                        }
                        placeholder="unassigned"
                        className="w-28 rounded border border-slate-200 px-1 py-0.5 outline-none focus:border-slate-900"
                      />
                    </td>
                    <td className="px-2 py-1 text-slate-400">{row.skipReason ?? 'import'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {preview.unmatchedScopes.length > 0 && (
            <p className="text-xs text-slate-500">
              Trades nothing matched: {preview.unmatchedScopes.slice(0, 10).join(' · ')}
            </p>
          )}
        </section>
      )}

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-2 font-medium">Company</th>
              <th className="px-4 py-2 font-medium">Divisions</th>
              <th className="px-4 py-2 font-medium">Contact</th>
              <th className="px-4 py-2 font-medium">Prequal</th>
              <th className="px-4 py-2 text-right font-medium">EMR</th>
            </tr>
          </thead>
          <tbody>
            {subs.slice(0, 300).map((sub) => (
              <tr key={sub.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2 font-medium text-slate-900">{sub.name}</td>
                <td className="px-4 py-2 font-mono text-xs text-slate-600">
                  {(sub.trade_csi ?? []).join(', ') || (
                    <span className="text-amber-700">unassigned</span>
                  )}
                </td>
                <td className="px-4 py-2 text-slate-600">
                  {sub.contact_name ?? '—'}
                  {sub.contact_email && (
                    <div className="text-xs text-slate-400">{sub.contact_email}</div>
                  )}
                </td>
                <td className="px-4 py-2 text-xs text-slate-500">{sub.prequal_status ?? '—'}</td>
                <td className="px-4 py-2 text-right text-slate-600">{sub.emr ?? '—'}</td>
              </tr>
            ))}
            {subs.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-sm text-slate-400">
                  No subcontractors yet. Import a list.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {subs.length > 300 && (
        <p className="text-xs text-slate-400">Showing the first 300 of {subs.length}.</p>
      )}
    </Layout>
  );
}
