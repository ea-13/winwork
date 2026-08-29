import { useEffect, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import type { HealthResponse } from 'shared';

type Probe = { state: 'loading' } | { state: 'done'; health: HealthResponse } | { state: 'unreachable' };

function Health() {
  const [probe, setProbe] = useState<Probe>({ state: 'loading' });

  useEffect(() => {
    fetch('/api/health')
      .then((response) => response.json() as Promise<HealthResponse>)
      .then((health) => setProbe({ state: 'done', health }))
      .catch(() => setProbe({ state: 'unreachable' }));
  }, []);

  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">WinProjects</h1>
      <p className="mt-1 text-sm text-slate-500">Scaffold — P1. No features yet.</p>

      <dl className="mt-8 rounded-lg border border-slate-200 p-4 text-sm">
        <dt className="font-medium text-slate-700">Database</dt>
        <dd className="mt-1 font-mono text-slate-600">
          {probe.state === 'loading' && 'checking…'}
          {probe.state === 'unreachable' && 'API unreachable — is the server running?'}
          {probe.state === 'done' &&
            (probe.health.db === 'connected' ? 'connected' : `error — ${probe.health.error}`)}
        </dd>
      </dl>
    </main>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Health />} />
    </Routes>
  );
}
