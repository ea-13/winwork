/**
 * Types shared by /client and /server.
 *
 * Two rules for this package: it imports from neither side, and nothing secret
 * lives here — it is bundled into the browser.
 */

/** GET /api/health */
export type HealthResponse =
  | { ok: true; db: 'connected' }
  | { ok: false; db: 'error'; error: string };
