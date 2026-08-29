import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../lib/session';

type Props = { children: ReactNode; breadcrumb?: ReactNode };

export function Layout({ children, breadcrumb }: Props) {
  const { email, roles, signOut } = useSession();

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-baseline gap-3">
            <Link to="/" className="text-sm font-semibold text-slate-900">
              WinProjects
            </Link>
            <nav className="flex gap-3 text-xs text-slate-500">
              <Link to="/ask" className="hover:text-slate-900">
                Ask an expert
              </Link>
              <Link to="/subcontractors" className="hover:text-slate-900">
                Subs
              </Link>
              <Link to="/archaeology" className="hover:text-slate-900">
                Archaeology
              </Link>
              <Link to="/review" className="hover:text-slate-900">
                Review queue
              </Link>
            </nav>
            {breadcrumb && <div className="text-xs text-slate-500">{breadcrumb}</div>}
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <span>{email}</span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600">
              {roles.join(' · ') || 'no roles'}
            </span>
            <button onClick={() => void signOut()} className="underline">
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">{children}</main>
    </div>
  );
}

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
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
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
