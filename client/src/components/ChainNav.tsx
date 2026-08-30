import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiGet } from '../lib/api';

export type ChainSummary = {
  documents: { total: number; unfiled: number; drawings: number; specs: number; indexed: number };
  scope: { total: number; locked: number };
  packages: { total: number; approved: number };
  bidders: { total: number; invited: number };
  bids: { total: number; extracted: number };
  leveling: { ranked: number };
  gaps: { total: number; open: number; critical: number; assigned: number };
};

export type ChainStep = 'documents' | 'scope' | 'bids' | 'buyout';

// Bids and leveling exist at BOTH levels: a summary across packages on the
// project, the detail inside one. Nothing is gated on choosing a package, and
// nothing is ever disabled — a step that is not ready says why underneath.
const STEPS: ChainStep[] = ['documents', 'scope', 'bids', 'buyout'];

const LABEL: Record<ChainStep, string> = {
  documents: 'Documents',
  scope: 'Scope & Packages',
  bids: 'Bids',
  // Levelling lives inside the buyout log now — it is what you find when you
  // open a package, not a separate place to go.
  buyout: 'Buyout & Leveling',
};

/**
 * The chain, made visible.
 *
 * Scope of Work → Sub Solicitation → Bid Leveling is the whole product, and
 * until this existed the app expressed it as two unrelated rows of tabs on two
 * different pages. Someone who did not already know the product could not tell
 * what to do first, which is a strange thing for a workflow tool to be unable
 * to say.
 *
 * Every step shows a count rather than a tick. "3 of 47 locked" tells an
 * estimator what to do next; a green check tells them nothing, and a percentage
 * tells them less.
 *
 * Steps are never disabled. A step that is not ready yet says why underneath —
 * being told "no packages yet" after clicking is a better experience than a
 * dead button that will not say what it wants.
 */
export function ChainNav({
  projectId,
  packageId,
  active,
  onSelectProjectStep,
  onSelectPackageStep,
  refreshKey,
}: {
  projectId: string;
  /** The package in context, if the user is inside one. */
  packageId?: string | null;
  active: ChainStep;
  /** Called when a project-level step is picked and we are already on the project page. */
  onSelectProjectStep?: (step: ChainStep) => void;
  /** Called when a package-level step is picked and we are already in a package. */
  onSelectPackageStep?: (step: ChainStep) => void;
  /** Change this to force a re-read of the counts after a mutation. */
  refreshKey?: number;
}) {
  const [summary, setSummary] = useState<ChainSummary | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    if (!projectId) return;
    setSummary(await apiGet<ChainSummary>(`/projects/${projectId}/chain`));
  }, [projectId]);

  useEffect(() => {
    // A stale count is worse than none, but a failed count must not take the
    // page down with it — this is navigation furniture, not the content.
    load().catch(() => setSummary(null));
  }, [load, refreshKey]);

  const detail = (step: ChainStep): { count: string; hint: string | null } => {
    if (!summary) return { count: '', hint: null };

    switch (step) {
      case 'documents':
        return {
          count: String(summary.documents.total),
          hint:
            summary.documents.total === 0
              ? 'drop the bid set'
              : summary.documents.unfiled > 0
                ? `${summary.documents.unfiled} to label`
                : summary.documents.drawings > summary.documents.indexed
                  ? `${summary.documents.drawings - summary.documents.indexed} to index`
                  : null,
        };
      case 'scope':
        return {
          count: String(summary.scope.total),
          hint:
            summary.scope.total === 0
              ? 'draft from the bid set'
              : `${summary.packages.total} package${summary.packages.total === 1 ? '' : 's'}`,
        };
      case 'bids':
        return {
          count: String(summary.bids.total),
          hint:
            summary.bids.total > 0 && summary.bids.extracted < summary.bids.total
              ? `${summary.bids.total - summary.bids.extracted} to extract`
              : null,
        };
      case 'buyout':
        return {
          count: String(summary.leveling.ranked),
          hint:
            summary.gaps.open > 0
              ? `${summary.gaps.open} gap${summary.gaps.open === 1 ? '' : 's'} open`
              : null,
        };
    }
  };

  /** Steps a package page can render itself. */
  const PACKAGE_STEPS: ChainStep[] = ['bids'];

  const go = (step: ChainStep) => {
    // Inside a package, bids and leveling stay inside it — clicking them should
    // show this package's detail, not throw you back to the project summary.
    if (packageId && PACKAGE_STEPS.includes(step)) {
      if (onSelectPackageStep) onSelectPackageStep(step);
      else navigate(`/packages/${packageId}?step=${step}`);
      return;
    }

    // Everything else lives on the project. From inside a package that means
    // navigating out, which is what the user asked for by clicking it.
    if (onSelectProjectStep) onSelectProjectStep(step);
    else navigate(`/projects/${projectId}?step=${step}`);
  };

  return (
    <nav aria-label="Workflow" className="overflow-x-auto">
      <ol className="flex w-full items-stretch gap-1">
        {STEPS.map((step, index) => {
          const { count, hint } = detail(step);
          const isActive = step === active;

          return (
            <li key={step} className="flex items-stretch">
              {index > 0 && (
                <span aria-hidden className="self-center px-1 text-ink-300">
                  ›
                </span>
              )}
              <button
                onClick={() => go(step)}
                aria-current={isActive ? 'step' : undefined}
                className={`min-w-[130px] flex-1 rounded-md border px-3 py-2 text-left transition ${
                  isActive
                    ? 'border-ink-900 bg-ink-900 text-white'
                    : 'border-ink-200 bg-white text-ink-700 hover:border-ink-400'
                }`}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium">{LABEL[step]}</span>
                  {count !== '' && (
                    <span
                      className={`text-xs tabular-nums ${
                        isActive ? 'text-ink-200' : 'text-ink-400'
                      }`}
                    >
                      {count}
                    </span>
                  )}
                </span>
                <span
                  className={`mt-0.5 block text-[10px] leading-tight ${
                    isActive ? 'text-ink-300' : 'text-ink-400'
                  }`}
                >
                  {hint ?? ' '}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {packageId && (
        <p className="mt-1.5 text-xs text-ink-400">
          Bids are per package.{' '}
          <Link to={`/projects/${projectId}?step=scope`} className="underline">
            Switch package
          </Link>
        </p>
      )}
    </nav>
  );
}
