import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityStream } from './ActivityStream';
import { fileSize } from './Layout';
import { PendingDrafts } from './PendingDrafts';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import { type UploadState, uploadBatch } from '../lib/upload';

export type ProjectDocument = {
  id: string;
  kind: string;
  filename: string;
  size_bytes: number | null;
  discipline: string | null;
  revision: string | null;
  page_count: number | null;
  indexed_at: string | null;
  routed_quote_id: string | null;
  uploaded_at: string;
};

type Sheet = {
  id: string;
  page_number: number;
  sheet_number: string | null;
  sheet_title: string | null;
  discipline: string | null;
};

const KINDS = ['UNFILED', 'DRAWING', 'SPEC', 'ADDENDUM', 'GEOTECH', 'QUOTE', 'OTHER'] as const;

const KIND_STYLE: Record<string, string> = {
  UNFILED: 'bg-amber-100 text-amber-800',
  DRAWING: 'bg-sky-100 text-sky-800',
  SPEC: 'bg-violet-100 text-violet-800',
  ADDENDUM: 'bg-orange-100 text-orange-800',
  GEOTECH: 'bg-stone-200 text-stone-700',
  QUOTE: 'bg-emerald-100 text-emerald-800',
  OTHER: 'bg-ink-100 text-ink-600',
};

/** One row of the upload queue. */
function QueueRow({ state }: { state: UploadState }) {
  const percent = Math.round(state.progress * 100);

  const bar =
    state.status === 'FAILED'
      ? 'bg-red-500'
      : state.status === 'DONE'
        ? 'bg-emerald-500'
        : 'bg-ink-900';

  const label =
    state.status === 'QUEUED'
      ? 'waiting'
      : state.status === 'UPLOADING'
        ? `${percent}%`
        : state.status === 'RECORDING'
          ? 'recording'
          : state.status === 'DONE'
            ? 'done'
            : state.status === 'CANCELLED'
              ? 'cancelled'
              : 'failed';

  return (
    <div className="px-3 py-2">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="truncate text-ink-700">{state.file.name}</span>
        <span className="shrink-0 tabular-nums text-ink-400">
          {fileSize(state.file.size)} · {label}
        </span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-ink-200">
        <div
          className={`h-full transition-all duration-150 ${bar}`}
          style={{ width: `${state.status === 'QUEUED' ? 0 : Math.max(percent, 2)}%` }}
        />
      </div>
      {state.error && <p className="mt-1 text-xs text-red-600">{state.error}</p>}
    </div>
  );
}

/**
 * The bid set: drop everything, say what it is afterwards.
 *
 * The previous version made you choose a kind BEFORE dropping, which is
 * backwards — you get a bid set as one download of forty files, and sorting it
 * into drawings and specs is something you do while looking at the list, not
 * something you know in advance. So everything lands as UNFILED and the kind is
 * a dropdown in the table.
 *
 * Progress is per file and real, read off the actual request. A single line
 * saying "uploading 12 of 40" tells you nothing about the 300MB file that has
 * been going for two minutes.
 */
export function DocumentDrop({
  projectId,
  onError,
  onChanged,
}: {
  projectId: string;
  onError: (message: string | null) => void;
  onChanged?: () => void;
}) {
  const [documents, setDocuments] = useState<ProjectDocument[]>([]);
  const [queue, setQueue] = useState<UploadState[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [packages, setPackages] = useState<{ id: string; name: string; lead_division: string | null }[]>([]);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const [docs, pkgs] = await Promise.all([
      apiGet<ProjectDocument[]>(`/projects/${projectId}/documents`),
      apiGet<{ id: string; name: string; lead_division: string | null }[]>(
        `/projects/${projectId}/packages`,
      ),
    ]);
    setDocuments(docs);
    setPackages(pkgs);
  }, [projectId]);

  /**
   * Files a quote that arrived with the bid set against the package it belongs
   * to. From there it is an ordinary bid and the extraction chain picks it up.
   */
  const routeQuote = (document: ProjectDocument, packageId: string) =>
    guard(async () => {
      const result = await apiPost<{ package: string }>(
        `/projects/${projectId}/documents/${document.id}/route-to-package`,
        { packageId },
      );
      await load();
      onChanged?.();
      onError(`${document.filename} filed under ${result.package}. Extract it on that package's Bids step.`);
    });

  useEffect(() => {
    load().catch((caught: Error) => onError(caught.message));
  }, [load, onError]);

  async function upload(files: File[]) {
    if (files.length === 0) return;
    onError(null);
    setUploading(true);

    const { failed } = await uploadBatch<ProjectDocument>(files, {
      signPath: `/projects/${projectId}/documents/signed-upload`,
      confirmPath: `/projects/${projectId}/documents/confirm`,
      // Everything lands unfiled. Labelling is the next screen, not this one.
      extra: { kind: 'UNFILED' },
      onChange: setQueue,
    });

    setUploading(false);
    if (failed.length > 0) {
      onError(`${failed.length} file(s) failed. The rest uploaded — see the list below.`);
    }
    await load().catch(() => undefined);
    onChanged?.();

    // Leave failures on screen; clear a clean run so the queue does not become
    // a permanent log of everything ever uploaded.
    if (failed.length === 0) window.setTimeout(() => setQueue([]), 1500);
  }

  async function setField(id: string, field: 'kind' | 'discipline' | 'revision', value: string) {
    onError(null);
    const previous = documents;
    setDocuments((current) =>
      current.map((row) => (row.id === id ? { ...row, [field]: value || null } : row)),
    );
    try {
      await apiPatch(`/records/project_document/${id}`, { [field]: value || null });
      onChanged?.();
    } catch (caught) {
      setDocuments(previous);
      onError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function openSheets(document: ProjectDocument) {
    if (expanded === document.id) {
      setExpanded(null);
      return;
    }
    setExpanded(document.id);
    setSheets([]);
    try {
      setSheets(await apiGet<Sheet[]>(`/documents/${document.id}/sheets`));
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  const guard = async (work: () => Promise<void>) => {
    setBusy(true);
    onError(null);
    try {
      await work();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const indexSheets = (document: ProjectDocument) =>
    guard(async () => {
      const { runId: id } = await apiPost<{ runId: string }>(
        `/projects/${projectId}/documents/${document.id}/index-sheets`,
      );
      setRunId(id);
    });

  const draftScope = () =>
    guard(async () => {
      const result = await apiPost<{ runId: string; documents: number; note: string | null }>(
        `/projects/${projectId}/draft-scope`,
        { documentIds: [...selected] },
      );
      setRunId(result.runId);
      if (result.note) onError(result.note);
    });

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const unfiled = documents.filter((row) => row.kind === 'UNFILED').length;
  const readable = documents.filter(
    (row) => row.kind === 'DRAWING' || row.kind === 'SPEC' || row.kind === 'ADDENDUM',
  );
  const selectedReadable = readable.filter((row) => selected.has(row.id));

  return (
    <section className="space-y-3">
      <PendingDrafts
        projectId={projectId}
        onError={onError}
        onAccepted={() => void load().then(() => onChanged?.())}
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
          dragging ? 'border-ink-900 bg-white text-ink-900' : 'border-ink-300 text-ink-500'
        }`}
      >
        <span className="font-medium">Drop the whole bid set here</span>
        <span className="mt-1 block text-xs">
          Drawings, specs, addenda, sub quotes — all of it at once. You label them
          afterwards, in the list.
        </span>
      </div>
      <input
        ref={picker}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          if (event.target.files) void upload(Array.from(event.target.files));
          event.target.value = '';
        }}
      />

      {queue.length > 0 && (
        <div className="divide-y divide-ink-100 rounded-lg border border-ink-200 bg-white">
          <div className="flex items-center justify-between px-3 py-2 text-xs font-medium text-ink-600">
            <span>
              {queue.filter((state) => state.status === 'DONE').length} of {queue.length} uploaded
            </span>
            {uploading && <span className="text-ink-400">uploading…</span>}
          </div>
          {queue.map((state) => (
            <QueueRow key={state.id} state={state} />
          ))}
        </div>
      )}

      {unfiled > 0 && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {unfiled} file{unfiled === 1 ? ' is' : 's are'} unfiled. Nothing can be drafted from a
          file until you say whether it is a drawing or a spec — they are read differently.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-500">
          {selectedReadable.length > 0
            ? `${selectedReadable.length} document${selectedReadable.length === 1 ? '' : 's'} selected`
            : 'Select drawings and specs to draft scope from them.'}
        </p>
        <button
          onClick={() => void draftScope()}
          disabled={busy || selectedReadable.length === 0}
          className="rounded-md bg-ink-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          title="Reads the selected documents and drafts scope items into the review queue"
        >
          Draft scope from {selectedReadable.length || ''} document
          {selectedReadable.length === 1 ? '' : 's'}
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-ink-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
              <th className="w-9 px-3 py-2" />
              <th className="px-3 py-2 font-medium">File</th>
              <th className="px-3 py-2 font-medium">What it is</th>
              <th className="px-3 py-2 font-medium">Disc.</th>
              <th className="px-3 py-2 font-medium">Rev</th>
              <th className="px-3 py-2 font-medium">Sheets</th>
              <th className="px-3 py-2 font-medium">Size</th>
            </tr>
          </thead>
          <tbody>
            {documents.map((document) => (
              <Fragment key={document.id}>
                <tr className="border-b border-ink-100 last:border-0">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(document.id)}
                      onChange={() => toggle(document.id)}
                      disabled={document.kind === 'UNFILED'}
                      title={
                        document.kind === 'UNFILED'
                          ? 'Label this file before drafting from it'
                          : undefined
                      }
                    />
                  </td>
                  <td className="px-3 py-2 text-ink-800">{document.filename}</td>
                  <td className="px-3 py-2">
                    <select
                      value={document.kind}
                      onChange={(event) => void setField(document.id, 'kind', event.target.value)}
                      className={`rounded px-1.5 py-0.5 text-xs font-medium outline-none ${
                        KIND_STYLE[document.kind] ?? KIND_STYLE.OTHER
                      }`}
                    >
                      {KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {kind.toLowerCase()}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      defaultValue={document.discipline ?? ''}
                      onBlur={(event) =>
                        event.target.value !== (document.discipline ?? '') &&
                        void setField(document.id, 'discipline', event.target.value)
                      }
                      placeholder="—"
                      className="w-12 rounded border border-transparent px-1 text-xs hover:border-ink-300 focus:border-ink-900 focus:outline-none"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      defaultValue={document.revision ?? ''}
                      onBlur={(event) =>
                        event.target.value !== (document.revision ?? '') &&
                        void setField(document.id, 'revision', event.target.value)
                      }
                      placeholder="—"
                      className="w-14 rounded border border-transparent px-1 text-xs hover:border-ink-300 focus:border-ink-900 focus:outline-none"
                    />
                  </td>
                  <td className="px-3 py-2">
                    {document.kind === 'QUOTE' ? (
                      document.routed_quote_id ? (
                        <span className="text-xs text-emerald-700">filed as a bid</span>
                      ) : (
                        <select
                          defaultValue=""
                          onChange={(event) => {
                            if (event.target.value) void routeQuote(document, event.target.value);
                          }}
                          className="rounded border border-ink-300 px-1.5 py-0.5 text-xs"
                          title="Which package is this bid against?"
                        >
                          <option value="">File under…</option>
                          {packages.map((pkg) => (
                            <option key={pkg.id} value={pkg.id}>
                              {pkg.lead_division} {pkg.name}
                            </option>
                          ))}
                        </select>
                      )
                    ) : document.kind === 'DRAWING' ? (
                      document.indexed_at ? (
                        <button
                          onClick={() => void openSheets(document)}
                          className="text-xs text-ink-700 underline"
                        >
                          {expanded === document.id ? 'hide' : 'view'} index
                        </button>
                      ) : (
                        <button
                          onClick={() => void indexSheets(document)}
                          disabled={busy}
                          className="rounded-md border border-ink-300 px-2 py-0.5 text-xs font-medium text-ink-700 disabled:opacity-40"
                          title="Reads every title block so scope can cite sheet numbers"
                        >
                          Index sheets
                        </button>
                      )
                    ) : (
                      <span className="text-xs text-ink-300">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-ink-500">{fileSize(document.size_bytes)}</td>
                </tr>

                {expanded === document.id && (
                  <tr className="border-b border-ink-100">
                    <td />
                    <td colSpan={6} className="px-3 pb-3">
                      <div className="max-h-64 overflow-auto rounded border border-ink-200">
                        <table className="w-full text-xs">
                          <tbody>
                            {sheets.map((sheet) => (
                              <tr key={sheet.id} className="border-b border-ink-100 last:border-0">
                                <td className="w-14 px-2 py-1 text-ink-400">
                                  p.{sheet.page_number}
                                </td>
                                <td className="w-24 px-2 py-1 font-mono text-ink-800">
                                  {sheet.sheet_number ?? '—'}
                                </td>
                                <td className="px-2 py-1 text-ink-600">
                                  {sheet.sheet_title ?? '—'}
                                </td>
                                <td className="w-10 px-2 py-1 text-ink-400">
                                  {sheet.discipline ?? ''}
                                </td>
                              </tr>
                            ))}
                            {sheets.length === 0 && (
                              <tr>
                                <td className="px-2 py-3 text-ink-400">Loading the index…</td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}

            {documents.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-sm text-ink-400">
                  No bid documents yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {runId && <ActivityStream runId={runId} />}

      <p className="text-xs text-ink-400">
        Drafted scope goes to the review queue, not straight into the project. An agent proposes;
        an estimator decides.
      </p>
    </section>
  );
}
