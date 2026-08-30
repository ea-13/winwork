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

/**
 * Roles are grants, not an enum. A user holds one or more; a two-estimator GC
 * commonly gives one person both BC and EST (spec section 3).
 */
export type Role = 'BC' | 'EST' | 'PM' | 'ADMIN';

/** The human gates. No agent may cross one (R4). */
export type Gate = 'H2' | 'H3' | 'H4' | 'H5' | 'H6';

/** GET /api/me */
export type SessionUser = {
  appUserId: string;
  tenantId: string;
  email: string;
  roles: Role[];
};

export type ApiError = { error: string };

/** Every gate crossing carries a rationale. Non-empty, always (spec section 3). */
export type GateRequest = { rationale: string };

export type GateResponse = {
  gate: Gate;
  approvalId: string;
  affected: number;
};

export type QuoteDocument = {
  id: string;
  sourceFilename: string | null;
  sourceSizeBytes: number | null;
  uploadedAt: string;
  /** MANUAL means a person typed it in and there is no source document (0015). */
  status: 'PENDING_EXTRACTION' | 'EXTRACTING' | 'EXTRACTED' | 'FAILED' | 'MANUAL';
};

export type AgentEvent = {
  seq: number;
  eventType: string;
  message: string;
  payload: unknown;
  at: string;
};

export type AgentRunSummary = {
  id: string;
  agentType: string;
  status: string;
  model: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  tokenCost: number | null;
};
