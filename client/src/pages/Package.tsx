import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { QuoteDocument } from 'shared';
import { ActivityStream } from '../components/ActivityStream';
import { ErrorBanner, Layout, fileSize } from '../components/Layout';
import { apiGet, apiPost } from '../lib/api';
import { directUpload } from '../lib/upload';

type WorkPackage = {
  id: string;
  name: string;
  status: string;
  lead_division: string | null;
  project_id: string;
};

export function PackagePage() {
  const { packageId = '' } = useParams();
  const [pkg, setPkg] = useState<WorkPackage | null>(null);
  const [documents, setDocuments] = useState<QuoteDocument[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const [packages, docs] = await Promise.all([
      apiGet<WorkPackage[]>('/packages'),
      apiGet<QuoteDocument[]>(`/packages/${packageId}/documents`),
    ]);
    setPkg(packages.find((row) => row.id === packageId) ?? null);
    setDocuments(docs);
  }, [packageId]);

  useEffect(() => {
    refresh().catch((caught: Error) => setError(caught.message));
  }, [refresh]);

  async function uploadFiles(files: File[]) {
    setError(null);
    for (const [index, file] of files.entries()) {
      setProgress(`Uploading ${index + 1} of ${files.length}: ${file.name}`);
      try {
        await directUpload<QuoteDocument>({
          signPath: `/packages/${packageId}/documents/signed-upload`,
          confirmPath: `/packages/${packageId}/documents/confirm`,
          file,
        });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        break;
      }
    }
    setProgress(null);
    await refresh().catch(() => undefined);
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

  return (
    <Layout
      breadcrumb={
        <>
          <Link to="/" className="underline">
            Projects
          </Link>
          {pkg && (
            <>
              {' · '}
              <Link to={`/projects/${pkg.project_id}`} className="underline">
                project
              </Link>
              {` · div ${pkg.lead_division ?? '—'}`}
            </>
          )}
        </>
      }
    >
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">{pkg?.name ?? 'Package'}</h1>
          <p className="text-sm text-slate-500">Sub bids for this package · {pkg?.status}</p>
        </div>
        <button
          onClick={() => void startDemoRun()}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700"
        >
          Run demo agent
        </button>
      </div>

      <ErrorBanner message={error} />

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void uploadFiles(Array.from(event.dataTransfer.files));
        }}
        onClick={() => picker.current?.click()}
        className={`cursor-pointer rounded-lg border-2 border-dashed px-4 py-10 text-center text-sm ${
          dragging ? 'border-slate-900 bg-white' : 'border-slate-300 text-slate-500'
        }`}
      >
        {progress ?? 'Drop sub bids here — or click to choose. PDF, XLSX, DOCX up to 50MB.'}
      </div>
      <input
        ref={picker}
        type="file"
        multiple
        accept=".pdf,.xlsx,.docx"
        className="hidden"
        onChange={(event) => {
          if (event.target.files) void uploadFiles(Array.from(event.target.files));
          event.target.value = '';
        }}
      />

      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-2 font-medium">Quote</th>
              <th className="px-4 py-2 font-medium">Size</th>
              <th className="px-4 py-2 font-medium">Uploaded</th>
              <th className="px-4 py-2 font-medium">Extraction</th>
            </tr>
          </thead>
          <tbody>
            {documents.map((document) => (
              <tr key={document.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2 text-slate-800">{document.sourceFilename ?? '—'}</td>
                <td className="px-4 py-2 text-slate-500">{fileSize(document.sourceSizeBytes)}</td>
                <td className="px-4 py-2 text-slate-500">
                  {new Date(document.uploadedAt).toLocaleString()}
                </td>
                <td className="px-4 py-2">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                    {document.status.replace(/_/g, ' ').toLowerCase()}
                  </span>
                </td>
              </tr>
            ))}
            {documents.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-sm text-slate-400">
                  No sub bids uploaded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {runId && <ActivityStream runId={runId} />}
    </Layout>
  );
}
