import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { basename, extname } from 'node:path';
import type { QuoteDocument } from 'shared';
import { requireRole } from '../lib/auth.js';
import { supabaseAdmin, supabaseForUser } from '../lib/supabase.js';

const QUOTE_BUCKET = 'quote-documents';
const PROJECT_BUCKET = 'project-documents';

/**
 * 50MB, which is the ceiling Supabase Storage allows on the free plan — not a
 * number we chose. A full stamped plan set runs well past it; raising it needs
 * Supabase Pro, and files that large should upload straight to storage with a
 * signed URL rather than being buffered here in server memory.
 */
const MAX_BYTES = 50 * 1024 * 1024;

const QUOTE_TYPES = new Map<string, string>([
  ['.pdf', 'application/pdf'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
]);

/** Drawings and specs arrive in more shapes than quotes do. */
const PROJECT_TYPES = new Map<string, string>([
  ...QUOTE_TYPES,
  ['.xls', 'application/vnd.ms-excel'],
  ['.doc', 'application/msword'],
  ['.zip', 'application/zip'],
  ['.dwg', 'image/vnd.dwg'],
  ['.dwf', 'model/vnd.dwf'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
]);

function makeUploader(allowed: Map<string, string>) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_BYTES, files: 20 },
    fileFilter: (_req, file, callback) => {
      const extension = extname(file.originalname).toLowerCase();
      if (allowed.has(extension)) {
        callback(null, true);
        return;
      }
      // Rejecting with an error rather than `false` so the response can name
      // the file and the accepted types, instead of a bare "no files".
      callback(
        new Error(
          `${file.originalname}: ${extension || 'no extension'} is not accepted. ` +
            `Allowed: ${[...allowed.keys()].join(', ')}`,
        ),
      );
    },
  });
}

/**
 * Multer reports failures by calling next(err), and an unhandled one falls
 * through to Express's default handler, which returns an HTML error page. The
 * browser then gets an unparseable body and the UI shows nothing useful — which
 * is exactly how a 63MB upload presented as "upload didn't work".
 */
function handleUpload(allowed: Map<string, string>) {
  const uploader = makeUploader(allowed).array('files');

  return (req: Request, res: Response, next: NextFunction): void => {
    uploader(req, res, (error: unknown) => {
      if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({
            error:
              `That file is larger than the ${MAX_BYTES / 1024 / 1024}MB limit, which is ` +
              'the maximum Supabase Storage allows on this plan.',
          });
          return;
        }
        res.status(400).json({ error: `${error.message} (${error.code})` });
        return;
      }
      if (error instanceof Error) {
        res.status(415).json({ error: error.message });
        return;
      }
      next();
    });
  };
}

const readyBuckets = new Set<string>();

async function ensureBucket(name: string): Promise<void> {
  if (readyBuckets.has(name)) return;
  const { data } = await supabaseAdmin.storage.getBucket(name);
  if (!data) {
    await supabaseAdmin.storage.createBucket(name, { public: false, fileSizeLimit: MAX_BYTES });
  } else if ((data.file_size_limit ?? 0) < MAX_BYTES) {
    await supabaseAdmin.storage.updateBucket(name, { public: false, fileSizeLimit: MAX_BYTES });
  }
  readyBuckets.add(name);
}

/** Storage keys are derived, never taken from the client. */
function safeName(original: string): string {
  return basename(original).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
}

export const documentsRouter = Router();

// -----------------------------------------------------------------------------
// Direct-to-storage uploads
//
// The multipart routes below buffer the whole file in server memory, which is
// fine for a 2MB quote and fatal for a plan set on a small container. These two
// endpoints hand the browser a short-lived signed URL so bytes go straight to
// Supabase and never touch this process; the server still decides the storage
// key and still writes the database row, so the tenant prefix and the RLS check
// stay where they were.
// -----------------------------------------------------------------------------

type SignedUpload = { bucket: string; path: string; token: string };

async function signUpload(bucket: string, path: string): Promise<SignedUpload | null> {
  await ensureBucket(bucket);
  const { data, error } = await supabaseAdmin.storage.from(bucket).createSignedUploadUrl(path);
  if (error || !data) return null;
  return { bucket, path: data.path, token: data.token };
}

/** The size storage actually received, rather than the size a client claimed. */
async function actualSize(bucket: string, path: string): Promise<number | null> {
  const directory = path.slice(0, path.lastIndexOf('/'));
  const name = path.slice(path.lastIndexOf('/') + 1);
  const { data } = await supabaseAdmin.storage.from(bucket).list(directory, { search: name });
  const match = data?.find((entry) => entry.name === name);
  const size = (match?.metadata as { size?: number } | undefined)?.size;
  return typeof size === 'number' ? size : null;
}

documentsRouter.post(
  '/projects/:projectId/documents/signed-upload',
  requireRole('BC', 'EST', 'PM'),
  async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const filename = typeof body.filename === 'string' ? safeName(body.filename) : '';
    const kind = typeof body.kind === 'string' ? body.kind.toUpperCase() : 'OTHER';
    if (!filename) {
      res.status(400).json({ error: 'filename is required' });
      return;
    }
    if (!PROJECT_TYPES.has(extname(filename).toLowerCase())) {
      res.status(415).json({
        error: `${extname(filename) || 'no extension'} is not accepted. Allowed: ${[...PROJECT_TYPES.keys()].join(', ')}`,
      });
      return;
    }

    const db = supabaseForUser(auth.token);
    const { data: project } = await db
      .from('project')
      .select('id')
      .eq('id', req.params.projectId)
      .maybeSingle();
    if (!project) {
      res.status(404).json({ error: 'No such project' });
      return;
    }

    const signed = await signUpload(
      PROJECT_BUCKET,
      `${auth.tenantId}/${req.params.projectId}/${kind.toLowerCase()}/${Date.now()}-${filename}`,
    );
    if (!signed) {
      res.status(500).json({ error: 'Could not create an upload URL' });
      return;
    }
    res.json(signed);
  },
);

documentsRouter.post(
  '/projects/:projectId/documents/confirm',
  requireRole('BC', 'EST', 'PM'),
  async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const path = typeof body.path === 'string' ? body.path : '';
    const filename = typeof body.filename === 'string' ? safeName(body.filename) : '';
    const kind = typeof body.kind === 'string' ? body.kind.toUpperCase() : 'OTHER';

    // The path was minted by this server for this tenant. Refuse anything else,
    // or a caller could register a row pointing at another tenant's object.
    if (!path.startsWith(`${auth.tenantId}/${req.params.projectId}/`)) {
      res.status(400).json({ error: 'That upload path does not belong to this project' });
      return;
    }

    const size = await actualSize(PROJECT_BUCKET, path);
    if (size === null) {
      res.status(400).json({ error: 'No uploaded object found at that path' });
      return;
    }

    const { data, error } = await supabaseForUser(auth.token)
      .from('project_document')
      .insert({
        tenant_id: auth.tenantId,
        project_id: req.params.projectId,
        kind: ['DRAWING', 'SPEC', 'ADDENDUM', 'GEOTECH', 'OTHER'].includes(kind) ? kind : 'OTHER',
        filename: filename || path.slice(path.lastIndexOf('/') + 1),
        size_bytes: size,
        storage_path: path,
        uploaded_by: auth.userId,
      })
      .select('id, kind, filename, size_bytes, uploaded_at')
      .single();

    if (error || !data) {
      res.status(500).json({ error: error?.message ?? 'Could not record the document' });
      return;
    }
    res.status(201).json(data);
  },
);

documentsRouter.post(
  '/packages/:packageId/documents/signed-upload',
  requireRole('BC', 'EST'),
  async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const filename = typeof body.filename === 'string' ? safeName(body.filename) : '';
    if (!filename || !QUOTE_TYPES.has(extname(filename).toLowerCase())) {
      res.status(415).json({
        error: `Quotes must be one of: ${[...QUOTE_TYPES.keys()].join(', ')}`,
      });
      return;
    }

    const db = supabaseForUser(auth.token);
    const { data: pkg } = await db
      .from('work_package')
      .select('id')
      .eq('id', req.params.packageId)
      .maybeSingle();
    if (!pkg) {
      res.status(404).json({ error: 'No such package' });
      return;
    }

    const signed = await signUpload(
      QUOTE_BUCKET,
      `${auth.tenantId}/${req.params.packageId}/${Date.now()}-${filename}`,
    );
    if (!signed) {
      res.status(500).json({ error: 'Could not create an upload URL' });
      return;
    }
    res.json(signed);
  },
);

documentsRouter.post(
  '/packages/:packageId/documents/confirm',
  requireRole('BC', 'EST'),
  async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const path = typeof body.path === 'string' ? body.path : '';
    const filename = typeof body.filename === 'string' ? safeName(body.filename) : '';

    if (!path.startsWith(`${auth.tenantId}/${req.params.packageId}/`)) {
      res.status(400).json({ error: 'That upload path does not belong to this package' });
      return;
    }

    const size = await actualSize(QUOTE_BUCKET, path);
    if (size === null) {
      res.status(400).json({ error: 'No uploaded object found at that path' });
      return;
    }

    const { data, error } = await supabaseForUser(auth.token)
      .from('quote')
      .insert({
        tenant_id: auth.tenantId,
        package_id: req.params.packageId,
        source_file_id: path,
        source_filename: filename || path.slice(path.lastIndexOf('/') + 1),
        source_size_bytes: size,
        uploaded_by: auth.userId,
        status: 'PENDING_EXTRACTION',
      })
      .select('id, source_filename, source_size_bytes, uploaded_at, status')
      .single();

    if (error || !data) {
      res.status(500).json({ error: error?.message ?? 'Could not record the quote' });
      return;
    }

    const document: QuoteDocument = {
      id: data.id,
      sourceFilename: data.source_filename,
      sourceSizeBytes: data.source_size_bytes,
      uploadedAt: data.uploaded_at,
      status: data.status,
    };
    res.status(201).json(document);
  },
);

// -----------------------------------------------------------------------------
// Project documents — the bid set. Drawings, specs, addenda.
// -----------------------------------------------------------------------------

documentsRouter.post(
  '/projects/:projectId/documents',
  requireRole('BC', 'EST', 'PM'),
  handleUpload(PROJECT_TYPES),
  async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const files = (req.files ?? []) as Express.Multer.File[];
    if (files.length === 0) {
      res.status(400).json({ error: 'No files were sent' });
      return;
    }

    const projectId = req.params.projectId;
    const db = supabaseForUser(auth.token);

    const { data: project } = await db
      .from('project')
      .select('id')
      .eq('id', projectId)
      .maybeSingle();
    if (!project) {
      res.status(404).json({ error: 'No such project' });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const kind = typeof body.kind === 'string' ? body.kind.toUpperCase() : 'OTHER';

    await ensureBucket(PROJECT_BUCKET);
    const created = [];

    for (const file of files) {
      const filename = safeName(file.originalname);
      const path = `${auth.tenantId}/${projectId}/${kind.toLowerCase()}/${Date.now()}-${filename}`;

      const { error: uploadError } = await supabaseAdmin.storage
        .from(PROJECT_BUCKET)
        .upload(path, file.buffer, {
          contentType: PROJECT_TYPES.get(extname(filename).toLowerCase()) ?? file.mimetype,
          upsert: false,
        });

      if (uploadError) {
        res.status(500).json({ error: `Upload failed for ${filename}: ${uploadError.message}` });
        return;
      }

      const { data, error } = await db
        .from('project_document')
        .insert({
          tenant_id: auth.tenantId,
          project_id: projectId,
          kind: ['DRAWING', 'SPEC', 'ADDENDUM', 'GEOTECH', 'OTHER'].includes(kind) ? kind : 'OTHER',
          filename,
          size_bytes: file.size,
          storage_path: path,
          uploaded_by: auth.userId,
        })
        .select('id, kind, filename, size_bytes, uploaded_at')
        .single();

      if (error || !data) {
        res.status(500).json({ error: error?.message ?? 'Could not record the document' });
        return;
      }
      created.push(data);
    }

    res.status(201).json(created);
  },
);

documentsRouter.get('/projects/:projectId/documents', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { data, error } = await supabaseForUser(auth.token)
    .from('project_document')
    .select('id, kind, filename, size_bytes, discipline, revision, uploaded_at')
    .eq('project_id', req.params.projectId)
    .order('uploaded_at', { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json(data ?? []);
});

// -----------------------------------------------------------------------------
// Package documents — the sub bids
// -----------------------------------------------------------------------------

documentsRouter.post(
  '/packages/:packageId/documents',
  requireRole('BC', 'EST'),
  handleUpload(QUOTE_TYPES),
  async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const files = (req.files ?? []) as Express.Multer.File[];
    if (files.length === 0) {
      res.status(400).json({ error: 'No files were sent' });
      return;
    }

    const packageId = req.params.packageId;
    const db = supabaseForUser(auth.token);

    const { data: pkg } = await db
      .from('work_package')
      .select('id')
      .eq('id', packageId)
      .maybeSingle();
    if (!pkg) {
      res.status(404).json({ error: 'No such package' });
      return;
    }

    await ensureBucket(QUOTE_BUCKET);
    const created: QuoteDocument[] = [];

    for (const file of files) {
      const filename = safeName(file.originalname);
      const path = `${auth.tenantId}/${packageId}/${Date.now()}-${filename}`;

      const { error: uploadError } = await supabaseAdmin.storage
        .from(QUOTE_BUCKET)
        .upload(path, file.buffer, {
          contentType: QUOTE_TYPES.get(extname(filename).toLowerCase()) ?? file.mimetype,
          upsert: false,
        });

      if (uploadError) {
        res.status(500).json({ error: `Upload failed for ${filename}: ${uploadError.message}` });
        return;
      }

      // Nothing has been read out of the document yet, so subcontractor_id and
      // every priced field stay null. R1: unknown stays unknown.
      const { data: quote, error: quoteError } = await db
        .from('quote')
        .insert({
          tenant_id: auth.tenantId,
          package_id: packageId,
          source_file_id: path,
          source_filename: filename,
          source_size_bytes: file.size,
          uploaded_by: auth.userId,
          status: 'PENDING_EXTRACTION',
        })
        .select('id, source_filename, source_size_bytes, uploaded_at, status')
        .single();

      if (quoteError || !quote) {
        res.status(500).json({ error: quoteError?.message ?? 'Could not record the quote' });
        return;
      }

      created.push({
        id: quote.id,
        sourceFilename: quote.source_filename,
        sourceSizeBytes: quote.source_size_bytes,
        uploadedAt: quote.uploaded_at,
        status: quote.status,
      });
    }

    res.status(201).json(created);
  },
);

documentsRouter.get('/packages/:packageId/documents', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { data, error } = await supabaseForUser(auth.token)
    .from('quote')
    .select('id, source_filename, source_size_bytes, uploaded_at, status')
    .eq('package_id', req.params.packageId)
    .order('uploaded_at', { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const documents: QuoteDocument[] = (data ?? []).map((row) => ({
    id: row.id,
    sourceFilename: row.source_filename,
    sourceSizeBytes: row.source_size_bytes,
    uploadedAt: row.uploaded_at,
    status: row.status,
  }));
  res.json(documents);
});
