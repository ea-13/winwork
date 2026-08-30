import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AskPanel } from './AskPanel';
import { RunningWork } from './RunningWork';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { useSession } from '../lib/session';

type Props = {
  children: ReactNode;
  breadcrumb?: ReactNode;
  /** Which project the docked expert should attach documents from. */
  projectId?: string | null;
};

/**
 * The shell.
 *
 * Wide but not edge-to-edge. A bid tab wants every pixel it can get, and text
 * running the full width of a 34" monitor is unreadable — a generous maximum
 * with real gutters gets both, because the grids scroll inside their own
 * container and use the width without the page losing its margins.
 */
export function Layout({ children, breadcrumb, projectId = null }: Props) {
  const { email, roles, signOut } = useSession();
  const { pathname } = useLocation();

  const nav = [
    { to: '/', label: 'Projects', active: pathname === '/' || pathname.startsWith('/projects') },
    { to: '/subcontractors', label: 'Subs', active: pathname.startsWith('/subcontractors') },
    { to: '/activity', label: 'Activity', active: pathname.startsWith('/activity') },
    { to: '/cost-codes', label: 'Cost codes', active: pathname.startsWith('/cost-codes') },
    { to: '/hindsight', label: 'Hindsight', active: pathname.startsWith('/hindsight') },
  ];

  return (
    <div className="flex min-h-screen w-full flex-col">
      <header className="sticky top-0 z-30 border-b border-ink-200 bg-ink-50/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[1680px] items-center gap-6 px-8 py-2.5">
          <Link to="/" className="text-[13px] font-semibold tracking-tight text-ink-900">
            WinProjects
          </Link>

          <span className="h-4 w-px bg-ink-200" />
          <WorkspaceSwitcher />
          <span className="h-4 w-px bg-ink-200" />

          <nav className="flex items-center gap-1">
            {nav.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={`rounded-md px-2 py-1 text-xs transition ${
                  item.active
                    ? 'bg-ink-200/70 font-medium text-ink-900'
                    : 'text-ink-500 hover:bg-ink-100 hover:text-ink-800'
                }`}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          {breadcrumb && <div className="min-w-0 truncate text-xs text-ink-400">{breadcrumb}</div>}

          <div className="ml-auto flex items-center gap-3 text-xs text-ink-400">
            <span className="hidden lg:inline">{email}</span>
            <span className="rounded bg-ink-100 px-1.5 py-0.5 text-[11px] font-medium text-ink-500">
              {roles.join(' · ') || 'no roles'}
            </span>
            <button
              onClick={() => void signOut()}
              className="rounded px-1.5 py-0.5 hover:bg-ink-100 hover:text-ink-800"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1680px] flex-1 space-y-5 px-8 py-6">{children}</main>

      <RunningWork projectId={projectId} />
      <AskPanel projectId={projectId} />
    </div>
  );
}

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="rounded-lg border border-flag-100 bg-flag-50 px-3 py-2 text-sm text-flag-700">
      {message}
    </p>
  );
}

export function fileSize(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function money(value: number | null): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

/**
 * A panel.
 *
 * One border weight, one radius, no shadow. Depth would compete with the data,
 * and there is only ever one thing on these screens worth looking at.
 */
export function Panel({
  title,
  hint,
  actions,
  flush,
  children,
}: {
  title?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  /** For a grid that supplies its own border. */
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-ink-200 bg-white">
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 px-4 py-2.5">
          <div className="min-w-0">
            {title && <h2 className="text-[13px] font-semibold text-ink-900">{title}</h2>}
            {hint && <p className="mt-0.5 text-xs text-ink-400">{hint}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={flush ? '' : 'p-4'}>{children}</div>
    </section>
  );
}
