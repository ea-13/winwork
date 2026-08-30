import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { BuyoutLog, type BuyoutView } from '../components/BuyoutLog';
import { ChainNav, type ChainStep } from '../components/ChainNav';
import { Copilot } from '../components/Copilot';
import { DocumentDrop } from '../components/DocumentDrop';
import { ErrorBanner, Layout } from '../components/Layout';
import { PackageOverview } from '../components/PackageOverview';
import { ScopePackages } from '../components/ScopePackages';
import { apiGet } from '../lib/api';
import type { Project } from './Projects';

/** The steps this page owns. Bids and leveling belong to a package. */
// Every step is reachable here. Bids and leveling render as a per-package
// summary at project level and as the detail once you are inside a package —
// blocking them behind 'pick a package first' hid the only view that answers
// 'where is this whole job up to'.
const STEPS: ChainStep[] = ['documents', 'scope', 'bids', 'buyout'];

const isProjectStep = (value: string | null): value is ChainStep =>
  value !== null && (STEPS as string[]).includes(value);

export function ProjectPage() {
  const { projectId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped after anything that changes a count, so the chain badges stay true.
  const [version, setVersion] = useState(0);

  const step: ChainStep = isProjectStep(params.get('step'))
    ? (params.get('step') as ChainStep)
    : 'documents';

  // Buyout and levelling are one step with two views. Keeping the choice in
  // the URL means a link lands on the one you meant, and a reload does not
  // quietly put you back on the money grid mid-bid-day.
  const buyoutView: BuyoutView = params.get('view') === 'leveling' ? 'leveling' : 'buyout';

  const setBuyoutView = useCallback(
    (next: BuyoutView) => {
      setParams((current) => {
        const updated = new URLSearchParams(current);
        updated.set('step', 'buyout');
        if (next === 'buyout') updated.delete('view');
        else updated.set('view', next);
        return updated;
      });
    },
    [setParams],
  );

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

  useEffect(() => {
    apiGet<Project>(`/projects/${projectId}`)
      .then(setProject)
      .catch((caught: Error) => setError(caught.message));
  }, [projectId]);

  const changed = useCallback(() => setVersion((current) => current + 1), []);

  return (
    <Layout
      projectId={projectId}
      breadcrumb={
        <>
          <Link to="/" className="hover:text-ink-700">
            Projects
          </Link>
          {project && <span> · {project.bid_id}</span>}
        </>
      }
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">
          {project?.name ?? 'Project'}
        </h1>
        <p className="text-xs text-ink-400">
          {project?.owner_org ?? 'No owner recorded'}
          {project?.due_at ? ` · bid due ${new Date(project.due_at).toLocaleDateString()}` : ''}
        </p>
      </div>

      <ChainNav
        projectId={projectId}
        active={step}
        onSelectProjectStep={setStep}
        refreshKey={version}
      />

      <Copilot projectId={projectId} refreshKey={version} onDid={changed} />

      <ErrorBanner message={error} />

      {step === 'documents' && (
        <DocumentDrop projectId={projectId} onError={setError} onChanged={changed} />
      )}

      {step === 'scope' && (
        <ScopePackages projectId={projectId} onError={setError} onChanged={changed} />
      )}

      {step === 'bids' && (
        <PackageOverview projectId={projectId} onError={setError} />
      )}

      {step === 'buyout' && (
        <BuyoutLog
          projectId={projectId}
          onError={setError}
          view={buyoutView}
          onViewChange={setBuyoutView}
        />
      )}
    </Layout>
  );
}
