import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useSession } from './lib/session';
import { Login } from './pages/Login';
import { PackagePage } from './pages/Package';
import { ProjectPage } from './pages/Project';
import { ProjectsPage } from './pages/Projects';

function Protected({ children }: { children: ReactNode }) {
  const { session, loading } = useSession();

  // Wait for the stored session to be read back before deciding, or a reload
  // bounces an authenticated user to the login screen.
  if (loading) {
    return <div className="p-8 text-sm text-slate-400">Loading…</div>;
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
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
