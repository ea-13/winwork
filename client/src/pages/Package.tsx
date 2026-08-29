import { useCallback, useEffect, useRef, useState } from 'react';
import type { QuoteDocument } from 'shared';
import { ActivityStream } from '../components/ActivityStream';
import { apiGet, apiPost, apiUpload } from '../lib/api';
import { useSession } from '../lib/session';

type WorkPackage = {
  id: string;
  name: string;
  status: string;
  csi_divisions: string[] | null;
};

function fileSize(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function PackagePage() {
  const { email, roles, signOut } = useSession();
  const [packages, setPackages] = useState<WorkPackage[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [documents, setDocuments] = useState<QuoteDocument[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    apiGet<WorkPackage[]>('/packages')
      .then((rows) => {
        setPackages(rows);
        setSelected((current) => current ?? rows[0]?.id ?? null);
      })
      .catch((caught: Error) => setError(caught.message));
  }, []);

  const refreshDocuments = useCallback(async (packageId: string) => {
    const rows = await apiGet<QuoteDocument[]>(`/packages/${packageId}/documents`);
    setDocuments(rows);
  }, []);

  useEffect(() => {
    if (!selected) return;
    refreshDocuments(selected).catch((caught: Error) => setError(caught.message));
  }, [selected, refreshDocuments]);

  async function upload(files: FileList | File[]) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await apiUpload<QuoteDocument[]>(`/packages/${selected}/documents`, Array.from(files));
      await refreshDocuments(selected);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function startDemoRun() {
    setError(null);
    try {
      const { runId: id } = await apiPost<{ runId: string }>('/agent-runs/demo');
      setRunId(id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  const current = packages.find((row) => row.id === selected);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
          <div>
            <h1 className="text-sm font-semibold text-slate-900">WinProjects</h1>
            <p className="text-xs text-slate-500">Riverside Medical Office TI · DEMO-2026-001</p>
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <span>{email}</span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600">
              {roles.join(' · ') || 'no roles'}
            </span>
            <button onClick={() => void signOut()} className="text-slate-500 underline">
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        {error && (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-medium text-slate-900">Package</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {packages.map((row) => (
              <button
                key={row.id}
                onClick={() => setSelected(row.id)}
                className={`rounded-md border px-3 py-1.5 text-sm ${
                  row.id === selected
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-300 text-slate-700'
                }`}
              >
                {row.name}
                <span className="ml-2 text-xs opacity-70">
                  div {row.csi_divisions?.join(', ') ?? '—'}
                </span>
              </button>
            ))}
            {packages.length === 0 && (
              <p className="text-sm text-slate-500">No packages. Run `npm run seed`.</p>
            )}
          </div>
          {current && (
            <p className="mt-3 text-xs text-slate-500">
              Status <span className="font-medium text-slate-700">{current.status}</span>
            </p>
          )}
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-slate-900">Quote documents</h2>
            <button
              onClick={() => void startDemoRun()}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700"
            >
              Run demo agent
            </button>
          </div>

          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              void upload(event.dataTransfer.files);
            }}
            onClick={() => picker.current?.click()}
            className={`mt-3 cursor-pointer rounded-md border-2 border-dashed px-4 py-8 text-center text-sm ${
              dragging ? 'border-slate-900 bg-slate-50' : 'border-slate-300 text-slate-500'
            }`}
          >
            {busy ? 'Uploading…' : 'Drop quotes here, or click to choose. PDF, XLSX, DOCX up to 25MB.'}
            <input
              ref={picker}
              type="file"
              multiple
              accept=".pdf,.xlsx,.docx"
              className="hidden"
              onChange={(event) => {
                if (event.target.files) void upload(event.target.files);
                event.target.value = '';
              }}
            />
          </div>

          <table className="mt-4 w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="pb-2 font-medium">File</th>
                <th className="pb-2 font-medium">Size</th>
                <th className="pb-2 font-medium">Uploaded</th>
                <th className="pb-2 font-medium">Extraction</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((document) => (
                <tr key={document.id} className="border-b border-slate-100">
                  <td className="py-2 text-slate-800">{document.sourceFilename ?? '—'}</td>
                  <td className="py-2 text-slate-500">{fileSize(document.sourceSizeBytes)}</td>
                  <td className="py-2 text-slate-500">
                    {new Date(document.uploadedAt).toLocaleString()}
                  </td>
                  <td className="py-2">
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                      {document.status.replace(/_/g, ' ').toLowerCase()}
                    </span>
                  </td>
                </tr>
              ))}
              {documents.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-4 text-sm text-slate-400">
                    Nothing uploaded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        {runId && <ActivityStream runId={runId} />}
      </main>
    </div>
  );
}
