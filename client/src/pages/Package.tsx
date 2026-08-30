import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { QuoteDocument } from 'shared';
import { ActivityStream } from '../components/ActivityStream';
import { BidTab } from '../components/BidTab';
import { ChainNav, type ChainStep } from '../components/ChainNav';
import { ErrorBanner, Layout, fileSize } from '../components/Layout';
import { LevelingMatrix } from '../components/LevelingMatrix';
import { ManualBid } from '../components/ManualBid';
import { Solicitation } from '../components/Solicitation';
import { apiGet, apiPost } from '../lib/api';
import { type UploadState, uploadBatch } from '../lib/upload';

type WorkPackage = {
  id: string;
  name: string;
  status: string;
  lead_division: string | null;
  csi_divisions: string[] | null;
  project_id: string;
};

/** The steps a package owns, plus scope which it shares with the project. */
const STEPS: ChainStep[] = ['bids', 'leveling'];

const isPackageStep = (value: string | null): value is ChainStep =>
  value !== null && (STEPS as string[]).includes(value);

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
  const [params, setParams] = useSearchParams();
  const [pkg, setPkg] = useState<WorkPackage | null>(null);
  const [documents, setDocuments] = useState<QuoteDocument[]>([]);
  const [queue, setQueue] = useState<UploadState[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [version, setVersion] = useState(0);
  const picker = useRef<HTMLInputElement>(null);

  const step: ChainStep = isPackageStep(params.get('step'))
    ? (params.get('step') as ChainStep)
    : 'bids';

  // Solicitation is optional. A GC who already has three quotes in hand should
  // never be walked through inviting bidders to get to a comparison.
  const [showBidders, setShowBidders] = useState(false);

  const setStep = useCallback(
    (next: ChainStep) => {
      setParams((current) => {
        const updated = new URLSearchParams(current);
        updated.set('step', next);
        return updated;
      });
    },
    [setParams],
  );

  const refresh = useCallback(async () => {
    const [packages, docs] = await Promise.all([
      apiGet<WorkPackage[]>('/packages'),
      apiGet<QuoteDocument[]>(`/packages/${packageId}/documents`),
    ]);
    setPkg(packages.find((row) => row.id === packageId) ?? null);
    setDocuments(docs);
    setVersion((current) => current + 1);
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

  async function upload(files: File[]) {
    if (files.length === 0) return;
    setError(null);

    const { failed } = await uploadBatch<QuoteDocument>(files, {
      signPath: `/packages/${packageId}/documents/signed-upload`,
      confirmPath: `/packages/${packageId}/documents/confirm`,
      onChange: setQueue,
    });

    if (failed.length > 0) {
      setError(`${failed.length} bid(s) failed to upload. The rest are listed below.`);
    }
    await refresh().catch(() => undefined);
    if (failed.length === 0) window.setTimeout(() => setQueue([]), 1500);
  }

  return (
    <Layout
      projectId={pkg?.project_id ?? null}
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
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">{pkg?.name ?? 'Package'}</h1>
          <p className="text-sm text-slate-500">
            {pkg?.status}
            {(pkg?.csi_divisions?.length ?? 0) > 1 &&
              ` · divisions ${pkg?.csi_divisions?.join(', ')}`}
          </p>
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
          className="shrink-0 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700"
          title="Extracts every un-read quote, then parks everything in the review queue. Crosses no gate."
        >
          Autopilot
        </button>
      </div>

      {pkg && (
        <ChainNav
          projectId={pkg.project_id}
          packageId={packageId}
          active={step}
          onSelectPackageStep={setStep}
          refreshKey={version}
        />
      )}

      <ErrorBanner message={error} />

      {step === 'bids' && (
        <section className="space-y-3">
          <ManualBid
            packageId={packageId}
            onError={setError}
            onAdded={() => void refresh()}
          />

          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              void upload(Array.from(event.dataTransfer.files));
            }}
            onClick={() => picker.current?.click()}
            className={`cursor-pointer rounded-lg border-2 border-dashed px-4 py-8 text-center text-sm transition ${
              dragging ? 'border-slate-900 bg-white text-slate-900' : 'border-slate-300 text-slate-500'
            }`}
          >
            <span className="font-medium">Drop sub bids here</span>
            <span className="mt-1 block text-xs">All of them at once. PDF, XLSX, DOCX.</span>
          </div>
          <input
            ref={picker}
            type="file"
            multiple
            accept=".pdf,.xlsx,.docx"
            className="hidden"
            onChange={(event) => {
              if (event.target.files) void upload(Array.from(event.target.files));
              event.target.value = '';
            }}
          />

          {queue.length > 0 && (
            <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
              {queue.map((state) => {
                const percent = Math.round(state.progress * 100);
                return (
                  <div key={state.id} className="px-3 py-2">
                    <div className="flex items-baseline justify-between gap-3 text-xs">
                      <span className="truncate text-slate-700">{state.file.name}</span>
                      <span className="shrink-0 tabular-nums text-slate-400">
                        {state.status === 'DONE' ? 'done' : `${percent}%`}
                      </span>
                    </div>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-slate-200">
                      <div
                        className={`h-full transition-all duration-150 ${
                          state.status === 'FAILED'
                            ? 'bg-red-500'
                            : state.status === 'DONE'
                              ? 'bg-emerald-500'
                              : 'bg-slate-900'
                        }`}
                        style={{ width: `${Math.max(percent, 2)}%` }}
                      />
                    </div>
                    {state.error && <p className="mt-1 text-xs text-red-600">{state.error}</p>}
                  </div>
                );
              })}
            </div>
          )}

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

          <div className="rounded-xl border border-ink-200 bg-white">
            <button
              onClick={() => setShowBidders((current) => !current)}
              className="flex w-full items-center justify-between px-4 py-2.5 text-left"
            >
              <span>
                <span className="text-[13px] font-semibold text-ink-900">Bidders</span>
                <span className="ml-2 text-xs text-ink-400">
                  Optional — only needed if you are soliciting. Bids you already
                  have can just be dropped above.
                </span>
              </span>
              <span className="text-xs text-ink-400">{showBidders ? 'hide' : 'show'}</span>
            </button>
            {showBidders && (
              <div className="border-t border-ink-100 p-4">
                <Solicitation packageId={packageId} onError={setError} />
              </div>
            )}
          </div>
        </section>
      )}

      {step === 'leveling' && (
        <div className="space-y-6">
          <LevelingMatrix packageId={packageId} onError={setError} />
          <BidTab packageId={packageId} onError={setError} />
        </div>
      )}

    </Layout>
  );
}
