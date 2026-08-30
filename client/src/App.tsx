import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useSession } from './lib/session';
import { ActivityPage } from './pages/ActivityPage';
import { CostCodesPage } from './pages/CostCodes';
import { HindsightPage } from './pages/Hindsight';
import { Login } from './pages/Login';
import { PackagePage } from './pages/Package';
import { ProjectPage } from './pages/Project';
import { ProjectsPage } from './pages/Projects';
import { ReviewQueuePage } from './pages/ReviewQueue';
import { SubsPage } from './pages/Subs';

function Protected({ children }: { children: ReactNode }) {
  const { session, loading } = useSession();

  // Wait for the stored session to be read back before deciding, or a reload
  // bounces an authenticated user to the login screen.
  if (loading) {
    return <div className="p-8 text-sm text-ink-400">Loading…</div>;
  }
  return session ? <>{children}</> : <Navigate to="/login" replace />;
}

export default function App() {
  const { session, loading } = useSession();

  return (
    <Routes>
      <Route
        path="/login"
        element={loading ? null : session ? <Navigate to="/" replace /> : <Login />}
      />
      <Route
        path="/"
        element={
          <Protected>
            <ProjectsPage />
          </Protected>
        }
      />
      <Route
        path="/projects/:projectId"
        element={
          <Protected>
            <ProjectPage />
          </Protected>
        }
      />
      <Route
        path="/packages/:packageId"
        element={
          <Protected>
            <PackagePage />
          </Protected>
        }
      />
      <Route
        path="/subcontractors"
        element={
          <Protected>
            <SubsPage />
          </Protected>
        }
      />
      <Route
        path="/review"
        element={
          <Protected>
            <ReviewQueuePage />
          </Protected>
        }
      />
      <Route
        path="/activity"
        element={
          <Protected>
            <ActivityPage />
          </Protected>
        }
      />
      <Route
        path="/cost-codes"
        element={
          <Protected>
            <CostCodesPage />
          </Protected>
        }
      />
      <Route
        path="/hindsight"
        element={
          <Protected>
            <HindsightPage />
          </Protected>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
