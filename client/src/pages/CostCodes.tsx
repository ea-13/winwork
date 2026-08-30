import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorBanner, Layout } from '../components/Layout';
import { apiGet, apiPost, apiUpload } from '../lib/api';

type CostCode = {
  id: string;
  code: string;
  description: string;
  csi_division: string | null;
  csi_section: string | null;
  source: string;
};

type Parsed = { code: string; description: string; csiDivision: string | null; csiSection: string | null };

type Preview = {
  filename: string;
  found: number;
  note: string | null;
  sample: Parsed[];
  codes: Parsed[];
};

/**
 * The tenant's own cost structure.
 *
 * CSI divisions stay as the shared vocabulary between tenants, because gap
 * patterns and division experts are knowledge that has to travel between jobs
 * and between customers. Cost codes are the opposite — they are a house
 * standard, they are what the estimator has in their head and what accounting
 * reconciles against, and a tool that makes them translate at every step is a
 * tool they use once and then export out of.
 *
 * Import is forgiving on purpose. A GC's structure arrives as whatever they
 * have: a codes tab in a template, a column in last year's bid, a sheet with
 * three header rows and a logo above them. Refusing anything that is not a
 * clean two-column file would mean nobody ever imports one, and then the
 * feature exists and is not used.
 */
export function CostCodesPage() {
  const [codes, setCodes] = useState<CostCode[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ code: '', description: '', csiDivision: '' });
  const picker = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setCodes(await apiGet<CostCode[]>('/cost-codes'));
  }, []);

  useEffect(() => {
    load().catch((caught: Error) => setError(caught.message));
  }, [load]);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiUpload<Preview>('/cost-codes/import/preview', [file]);
      setPreview(result);
      if (result.note) setError(result.note);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiPost<{ imported: number; skipped: number }>('/cost-codes/import', {
        codes: preview.codes,
        source: 'TEMPLATE',
      });
      setPreview(null);
      await load();
      setError(
        `Imported ${result.imported} code${result.imported === 1 ? '' : 's'}` +
          (result.skipped > 0 ? `. ${result.skipped} already existed.` : '.'),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const byDivision = codes.reduce<Record<string, CostCode[]>>((out, code) => {
    const key = code.csi_division ?? 'unmapped';
    out[key] = [...(out[key] ?? []), code];
    return out;
  }, {});

  return (
    <Layout breadcrumb={<span>Cost codes</span>}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink-900">Cost codes</h1>
          <p className="text-xs text-ink-400">
            Your own structure. CSI stays the shared language between projects; this is what your
            estimators and your accounting actually use.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAdding((value) => !value)}
            className="rounded-md border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700"
          >
            + Add one
          </button>
          <button
            onClick={() => picker.current?.click()}
            disabled={busy}
            className="rounded-md bg-ink-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          >
            Import from a file
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
      </div>

      <ErrorBanner message={error} />

      {adding && (
        <div className="flex flex-wrap items-end gap-2 rounded-xl border border-ink-200 bg-white p-4">
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] uppercase tracking-wide text-ink-400">Code</span>
            <input
              value={draft.code}
              onChange={(event) => setDraft({ ...draft, code: event.target.value })}
              placeholder="09-100"
              className="w-32 rounded border border-ink-300 px-2 py-1 text-xs outline-none focus:border-ink-800"
            />
          </label>
          <label className="flex flex-1 flex-col gap-0.5">
            <span className="text-[10px] uppercase tracking-wide text-ink-400">Description</span>
            <input
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              placeholder="Drywall and metal framing"
              className="w-full rounded border border-ink-300 px-2 py-1 text-xs outline-none focus:border-ink-800"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] uppercase tracking-wide text-ink-400">CSI div</span>
            <input
              value={draft.csiDivision}
              onChange={(event) => setDraft({ ...draft, csiDivision: event.target.value })}
              placeholder="09"
              className="w-16 rounded border border-ink-300 px-2 py-1 text-xs outline-none focus:border-ink-800"
            />
          </label>
          <button
            disabled={busy || draft.code.trim() === '' || draft.description.trim() === ''}
            onClick={() =>
              void (async () => {
                setBusy(true);
                try {
                  await apiPost('/cost-codes', draft);
                  setDraft({ code: '', description: '', csiDivision: '' });
                  await load();
                } catch (caught) {
                  setError(caught instanceof Error ? caught.message : String(caught));
                } finally {
                  setBusy(false);
                }
              })()
            }
            className="rounded-md bg-ink-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          >
            Add
          </button>
        </div>
      )}

      {preview && (
        <div className="rounded-xl border border-ink-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 px-4 py-2.5">
            <div>
              <p className="text-[13px] font-semibold text-ink-900">
                {preview.found} code{preview.found === 1 ? '' : 's'} found in {preview.filename}
              </p>
              <p className="text-xs text-ink-400">
                Nothing is saved yet. Check the first few look right — the header row is found by
                scanning, so a file with a logo above it still works.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setPreview(null)} className="text-xs text-ink-400">
                cancel
              </button>
              <button
                onClick={() => void commit()}
                disabled={busy || preview.found === 0}
                className="rounded-md bg-ink-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
              >
                Import {preview.found}
              </button>
            </div>
          </div>

          <table className="w-full text-xs">
            <tbody>
              {preview.sample.map((code, index) => (
                <tr key={index} className="border-b border-ink-50 last:border-0">
                  <td className="w-32 px-4 py-1 font-mono text-ink-700">{code.code}</td>
                  <td className="px-4 py-1 text-ink-800">{code.description}</td>
                  <td className="w-16 px-4 py-1 text-ink-400">{code.csiDivision ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {preview.found > preview.sample.length && (
            <p className="border-t border-ink-100 px-4 py-2 text-[11px] text-ink-400">
              Showing {preview.sample.length} of {preview.found}. All of them import.
            </p>
          )}
        </div>
      )}

      {codes.length === 0 && !preview && (
        <div className="rounded-xl border border-ink-200 bg-white px-4 py-8 text-center">
          <p className="text-sm text-ink-500">No cost codes yet.</p>
          <p className="mx-auto mt-1 max-w-lg text-xs text-ink-400">
            Import them from a template, or from a past bid — the file does not have to be tidy.
            Once they exist, the assistant can file this project's scope under them, and everything
            reconciles with how you already estimate.
          </p>
        </div>
      )}

      {Object.entries(byDivision)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([division, group]) => (
          <div key={division} className="overflow-hidden rounded-xl border border-ink-200 bg-white">
            <p className="border-b border-ink-100 bg-ink-50 px-4 py-1.5 text-xs font-semibold text-ink-700">
              {division === 'unmapped' ? 'No CSI division' : `Division ${division}`}
              <span className="ml-2 font-normal text-ink-400">{group.length}</span>
            </p>
            <table className="w-full text-xs">
              <tbody>
                {group.map((code) => (
                  <tr key={code.id} className="border-b border-ink-50 last:border-0">
                    <td className="w-32 px-4 py-1.5 font-mono text-ink-700">{code.code}</td>
                    <td className="px-4 py-1.5 text-ink-800">{code.description}</td>
                    <td className="w-24 px-4 py-1.5 text-[10px] text-ink-300">
                      {code.source.toLowerCase()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </Layout>
  );
}
