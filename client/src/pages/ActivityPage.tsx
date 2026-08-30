import { useState } from 'react';
import { Activity } from '../components/Activity';
import { ErrorBanner, Layout } from '../components/Layout';

/**
 * The agent queue, on its own screen.
 *
 * It is also embedded on the project page, but it needs a home you can reach
 * without a project in mind — "what is this thing doing and what is it costing
 * me" is a question you ask about the whole system, not about one job.
 */
export function ActivityPage() {
  const [error, setError] = useState<string | null>(null);

  return (
    <Layout breadcrumb={<span>Activity</span>}>
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">Activity</h1>
        <p className="text-xs text-ink-400">
          Everything the agents are doing, waiting to do, or have just finished. Stop anything, or
          move it to the front.
        </p>
      </div>

      <ErrorBanner message={error} />
      <Activity onError={setError} />
    </Layout>
  );
}
