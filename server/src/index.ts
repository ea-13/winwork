import cors from 'cors';
import express from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './env.js';
import { requireAuth } from './lib/auth.js';
import { startWorker } from './lib/worker.js';
import { agentRunsRouter } from './routes/agent-runs.js';
import { archaeologyRouter } from './routes/archaeology.js';
import { autopilotRouter } from './routes/autopilot.js';
import { buyoutRouter } from './routes/buyout.js';
import { chatRouter } from './routes/chat.js';
import { consultRouter } from './routes/consult.js';
import { copilotRouter } from './routes/copilot.js';
import { contextRouter } from './routes/context.js';
import { corpusRouter } from './routes/corpus.js';
import { costCodesRouter } from './routes/cost-codes.js';
import { documentsRouter } from './routes/documents.js';
import { gatesRouter } from './routes/gates.js';
import { levelingRouter } from './routes/leveling.js';
import { healthRouter } from './routes/health.js';
import { projectsRouter } from './routes/projects.js';
import { quotesRouter } from './routes/quotes.js';
import { recordsRouter } from './routes/records.js';
import { sessionRouter } from './routes/session.js';
import { solicitationRouter } from './routes/solicitation.js';
import { subsRouter } from './routes/subs.js';
import { workspacesRouter } from './routes/workspaces.js';

const app = express();

app.use(cors());
app.use(express.json());

// Public: liveness only.
app.use('/api', healthRouter);

// Everything else requires a verified session. Mounting the guard here rather
// than per-route means a new route is protected by default — forgetting to add
// auth is the mistake that matters, so the layout makes it the harder one.
app.use('/api', requireAuth, sessionRouter);
app.use('/api', requireAuth, recordsRouter);
app.use('/api', requireAuth, projectsRouter);
app.use('/api', requireAuth, documentsRouter);
app.use('/api', requireAuth, quotesRouter);
app.use('/api', requireAuth, levelingRouter);
app.use('/api', requireAuth, buyoutRouter);
app.use('/api', requireAuth, subsRouter);
app.use('/api', requireAuth, workspacesRouter);
app.use('/api', requireAuth, solicitationRouter);
app.use('/api', requireAuth, autopilotRouter);
app.use('/api', requireAuth, corpusRouter);
app.use('/api', requireAuth, costCodesRouter);
app.use('/api', requireAuth, consultRouter);
app.use('/api', requireAuth, contextRouter);
app.use('/api', requireAuth, copilotRouter);
app.use('/api', requireAuth, chatRouter);
app.use('/api', requireAuth, archaeologyRouter);
app.use('/api', requireAuth, agentRunsRouter);
app.use('/api/gates', requireAuth, gatesRouter);

// In production the API also serves the built client, so the deployment is a
// single origin with a single URL. In dev, Vite serves the client and proxies
// /api here instead.
if (env.isProduction) {
  const here = dirname(fileURLToPath(import.meta.url));
  const clientDist = resolve(here, '../../client/dist');

  app.use(express.static(clientDist));
  app.use((_req, res) => {
    res.sendFile(resolve(clientDist, 'index.html'));
  });
}

app.listen(env.port, () => {
  console.log(`server listening on http://localhost:${env.port}`);
  startWorker();
});
