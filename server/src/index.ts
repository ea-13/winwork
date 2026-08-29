import cors from 'cors';
import express from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './env.js';
import { healthRouter } from './routes/health.js';

const app = express();

app.use(cors());
app.use(express.json());
app.use('/api', healthRouter);

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
});
