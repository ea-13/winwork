import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { QuoteDocument } from 'shared';
import { ActivityStream } from '../components/ActivityStream';
import { ErrorBanner, Layout, fileSize } from '../components/Layout';
import { LevelingMatrix } from '../components/LevelingMatrix';
import { PackageScope } from '../components/PackageScope';
import { RiskLog } from '../components/RiskLog';
import { Solicitation } from '../components/Solicitation';
import { apiGet, apiPost } from '../lib/api';
import { directUpload } from '../lib/upload';

type WorkPackage = {
  id: string;
  name: string;
  status: string;
  lead_division: string | null;
  project_id: string;
};

/** Promotion is a human act and needs a reason, so it asks for one inline. */
function Promote({
  label,
  hint,
  onConfirm,
}: {
  label: string;
  hint: string;
  onConfirm: (rationale: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700"
      >
        {label}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <input
        autoFocus
        value={rationale}
        onChange={(event) => setRationale(event.target.value)}
        placeholder={hint}
        className="w-56 rounded border border-slate-300 px-2 py-1 text-xs outline-none focus:border-slate-900"
      />
      <button
        disabled={busy || rationale.trim() === ''}
        onClick={async () => {
          setBusy(true);
          await onConfirm(rationale.trim());
          setBusy(false);
          setOpen(false);
          setRationale('');
        }}
        className="rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
      >
        {busy ? '…' : 'Confirm'}
      </button>
      <button onClick={() => setOpen(false)} className="px-1 text-xs text-slate-400">
        cancel
      </button>
    </div>
  );
}

export function PackagePage() {
  const { packageId = '' } = useParams();
  const [tab, setTab] = useState<'scope' | 'bids' | 'bidders' | 'leveling' | 'gaps'>('bids');
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

  const guard = async (work: () => Promise<void>) => {
    setError(null);
    try {
      await work();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

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
          <p className="text-sm text-slate-500">{pkg?.status}</p>
        </div>
        <button
          onClick={() =>
            void guard(async () => {
              const result = await apiPost<{ queued: number; note: string }>(
                `/packages/${packageId}/autopilot`,
              );
              setError(result.note);
            })
          }
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700"
          title="Extracts every un-read quote, then parks everything in the review queue. Crosses no gate."
        >
          Autopilot
        </button>
      </div>

      <ErrorBanner message={error} />

      <nav className="flex gap-1 border-b border-slate-200">
        {(['scope', 'bids', 'bidders', 'leveling', 'gaps'] as const).map((name) => (
          <button
            key={name}
            onClick={() => setTab(name)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm capitalize ${
              tab === name
                ? 'border-slate-900 font-medium text-slate-900'
                : 'border-transparent text-slate-500'
            }`}
          >
            {name}
            {name === 'bids' && (
              <span className="ml-1.5 text-xs text-slate-400">{documents.length}</span>
            )}
          </button>
        ))}
      </nav>

      {tab === 'scope' && (
        <PackageScope
          packageId={packageId}
          projectId={pkg?.project_id ?? null}
          onError={setError}
        />
      )}

      {tab === 'bids' && (
        <section className="space-y-3">
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
            className={`cursor-pointer rounded-lg border-2 border-dashed px-4 py-8 text-center text-sm ${
              dragging ? 'border-slate-900 bg-white' : 'border-slate-300 text-slate-500'
            }`}
          >
            {progress ?? 'Drop sub bids here — or click to choose. PDF, XLSX, DOCX.'}
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

          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2 font-medium">Quote</th>
                  <th className="px-4 py-2 font-medium">Size</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Steps</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((document) => (
                  <tr key={document.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2 text-slate-800">{document.sourceFilename ?? '—'}</td>
                    <td className="px-4 py-2 text-slate-500">
                      {fileSize(document.sourceSizeBytes)}
                    </td>
                    <td className="px-4 py-2">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                        {document.status.replace(/_/g, ' ').toLowerCase()}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          onClick={() =>
                            void guard(async () => {
                              const { runId: id } = await apiPost<{ runId: string }>(
                                `/quotes/${document.id}/extract`,
                              );
                              setRunId(id);
                            })
                          }
                          className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700"
                        >
                          {document.status === 'EXTRACTED' ? 'Re-extract' : '1 · Extract'}
                        </button>

                        <Promote
                          label="2 · Accept extraction"
                          hint="Why are you accepting this?"
                          onConfirm={(rationale) =>
                            guard(async () => {
                              await apiPost(`/quotes/${document.id}/promote`, { rationale });
                            })
                          }
                        />

                        <button
                          onClick={() =>
                            void guard(async () => {
                              const { runId: id } = await apiPost<{ runId: string }>(
                                `/quotes/${document.id}/normalise`,
                              );
                              setRunId(id);
                            })
                          }
                          className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700"
                        >
                          3 · Normalise
                        </button>

                        <Promote
                          label="4 · Accept mapping"
                          hint="Why are you accepting this mapping?"
                          onConfirm={(rationale) =>
                            guard(async () => {
                              await apiPost(`/quotes/${document.id}/promote-normalisation`, {
                                rationale,
                              });
                            })
                          }
                        />
                      </div>
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
          </div>

          {runId && <ActivityStream runId={runId} />}
        </section>
      )}

      {tab === 'bidders' && <Solicitation packageId={packageId} onError={setError} />}

      {tab === 'leveling' && <LevelingMatrix packageId={packageId} onError={setError} />}

      {tab === 'gaps' && (
        <RiskLog packageId={packageId} projectId={pkg?.project_id ?? null} onError={setError} />
      )}
    </Layout>
  );
}
