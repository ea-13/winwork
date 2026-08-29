import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ErrorBanner, Layout, fileSize, money } from '../components/Layout';
import { apiGet, apiPost } from '../lib/api';
import { directUpload } from '../lib/upload';
import type { Project } from './Projects';

type Division = { code: string; title: string };

type WorkPackage = {
  id: string;
  name: string;
  status: string;
  lead_division: string | null;
  csi_divisions: string[] | null;
  budget_amount: number | null;
  allowance_amount: number | null;
  contingency_amount: number | null;
};

type ProjectDocument = {
  id: string;
  kind: string;
  filename: string;
  size_bytes: number | null;
  uploaded_at: string;
};

const KINDS = ['DRAWING', 'SPEC', 'ADDENDUM', 'GEOTECH', 'OTHER'] as const;

export function ProjectPage() {
  const { projectId = '' } = useParams();
  const [tab, setTab] = useState<'documents' | 'packages'>('documents');
  const [project, setProject] = useState<Project | null>(null);
  const [documents, setDocuments] = useState<ProjectDocument[]>([]);
  const [packages, setPackages] = useState<WorkPackage[]>([]);
  const [divisions, setDivisions] = useState<Division[]>([]);
  const [kind, setKind] = useState<(typeof KINDS)[number]>('DRAWING');
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const [p, docs, pkgs, divs] = await Promise.all([
      apiGet<Project>(`/projects/${projectId}`),
      apiGet<ProjectDocument[]>(`/projects/${projectId}/documents`),
      apiGet<WorkPackage[]>(`/projects/${projectId}/packages`),
      apiGet<Division[]>('/divisions'),
    ]);
    setProject(p);
    setDocuments(docs);
    setPackages(pkgs);
    setDivisions(divs);
  }, [projectId]);

  useEffect(() => {
    refresh().catch((caught: Error) => setError(caught.message));
  }, [refresh]);

  async function uploadFiles(files: File[]) {
    setError(null);
    for (const [index, file] of files.entries()) {
      setProgress(`Uploading ${index + 1} of ${files.length}: ${file.name}`);
      try {
        await directUpload({
          signPath: `/projects/${projectId}/documents/signed-upload`,
          confirmPath: `/projects/${projectId}/documents/confirm`,
          file,
          extra: { kind },
        });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        break;
      }
    }
    setProgress(null);
    await refresh().catch(() => undefined);
  }

  async function addPackage(division: Division) {
    setError(null);
    try {
      await apiPost(`/projects/${projectId}/packages`, { leadDivision: division.code });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  const used = new Set(packages.map((row) => row.lead_division));

  return (
    <Layout
      breadcrumb={
        <>
          <Link to="/" className="underline">
            Projects
          </Link>
          {project && <span> · {project.bid_id}</span>}
        </>
      }
    >
      <div>
        <h1 className="text-lg font-semibold text-slate-900">{project?.name ?? 'Project'}</h1>
        <p className="text-sm text-slate-500">
          {project?.owner_org ?? 'No owner recorded'}
          {project?.due_at ? ` · bid due ${new Date(project.due_at).toLocaleDateString()}` : ''}
        </p>
      </div>

      <ErrorBanner message={error} />

      <nav className="flex gap-1 border-b border-slate-200">
        {(['documents', 'packages'] as const).map((name) => (
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
            <span className="ml-1.5 text-xs text-slate-400">
              {name === 'documents' ? documents.length : packages.length}
            </span>
          </button>
        ))}
      </nav>

      {tab === 'documents' && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-600">Upload as</span>
            {KINDS.map((option) => (
              <button
                key={option}
                onClick={() => setKind(option)}
                className={`rounded-md border px-2.5 py-1 text-xs ${
                  kind === option
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-300 text-slate-600'
                }`}
              >
                {option.toLowerCase()}
              </button>
            ))}
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
              void uploadFiles(Array.from(event.dataTransfer.files));
            }}
            onClick={() => picker.current?.click()}
            className={`cursor-pointer rounded-lg border-2 border-dashed px-4 py-10 text-center text-sm ${
              dragging ? 'border-slate-900 bg-white' : 'border-slate-300 text-slate-500'
            }`}
          >
            {progress ?? 'Drop drawings, specs or addenda here — or click to choose. Up to 50MB each.'}
          </div>
          <input
            ref={picker}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              if (event.target.files) void uploadFiles(Array.from(event.target.files));
              event.target.value = '';
            }}
          />

          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2 font-medium">File</th>
                  <th className="px-4 py-2 font-medium">Kind</th>
                  <th className="px-4 py-2 font-medium">Size</th>
                  <th className="px-4 py-2 font-medium">Uploaded</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((document) => (
                  <tr key={document.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2 text-slate-800">{document.filename}</td>
                    <td className="px-4 py-2">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                        {document.kind.toLowerCase()}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-slate-500">{fileSize(document.size_bytes)}</td>
                    <td className="px-4 py-2 text-slate-500">
                      {new Date(document.uploaded_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
                {documents.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-sm text-slate-400">
                      No bid documents yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'packages' && (
        <section className="space-y-4">
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-medium text-slate-900">Add a package by division</h2>
            <p className="mt-1 text-xs text-slate-500">
              A GC buys by trade. Each package gets its own bidders, quotes and buyout line.
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {divisions.map((division) => (
                <button
                  key={division.code}
                  onClick={() => void addPackage(division)}
                  disabled={used.has(division.code)}
                  className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 disabled:cursor-not-allowed disabled:opacity-35"
                  title={division.title}
                >
                  {division.code} {division.title}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2 font-medium">Div</th>
                  <th className="px-4 py-2 font-medium">Package</th>
                  <th className="px-4 py-2 font-medium">Budget</th>
                  <th className="px-4 py-2 font-medium">Allowance</th>
                  <th className="px-4 py-2 font-medium">Contingency</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {packages.map((row) => (
                  <tr key={row.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2 font-mono text-xs text-slate-500">
                      {row.lead_division ?? '—'}
                    </td>
                    <td className="px-4 py-2">
                      <Link to={`/packages/${row.id}`} className="font-medium text-slate-900 underline">
                        {row.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-slate-600">{money(row.budget_amount)}</td>
                    <td className="px-4 py-2 text-slate-600">{money(row.allowance_amount)}</td>
                    <td className="px-4 py-2 text-slate-600">{money(row.contingency_amount)}</td>
                    <td className="px-4 py-2">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                        {row.status}
                      </span>
                    </td>
                  </tr>
                ))}
                {packages.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-sm text-slate-400">
                      No packages yet. Add one per division above.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </Layout>
  );
}
