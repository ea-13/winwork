import { Router } from 'express';
import multer from 'multer';
import { basename, extname } from 'node:path';
import type { QuoteDocument } from 'shared';
import { requireRole } from '../lib/auth.js';
import { supabaseAdmin, supabaseForUser } from '../lib/supabase.js';

const BUCKET = 'quote-documents';
const MAX_BYTES = 25 * 1024 * 1024;

const ALLOWED = new Map<string, string>([
  ['.pdf', 'application/pdf'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 10 },
  fileFilter: (_req, file, callback) => {
    const extension = extname(file.originalname).toLowerCase();
    callback(null, ALLOWED.has(extension));
  },
});

let bucketReady = false;

/** Private bucket, created on first use so deployment needs no manual step. */
async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  const { data } = await supabaseAdmin.storage.getBucket(BUCKET);
  if (!data) {
    await supabaseAdmin.storage.createBucket(BUCKET, {
      public: false,
      fileSizeLimit: MAX_BYTES,
    });
  }
  bucketReady = true;
}

/**
 * Storage keys are derived, never taken from the client. A filename arriving
 * over HTTP is attacker-controlled: basename() strips any directory part, and
 * the remaining characters are narrowed so nothing can climb out of the
 * tenant's prefix.
 */
function safeName(original: string): string {
  return basename(original).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
}

export const documentsRouter = Router();

documentsRouter.post(
  '/packages/:packageId/documents',
  requireRole('BC', 'EST'),
  upload.array('files'),
  async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const files = (req.files ?? []) as Express.Multer.File[];
    if (files.length === 0) {
      res.status(400).json({ error: 'No accepted files. Allowed types: PDF, XLSX, DOCX' });
      return;
    }

    const packageId = req.params.packageId;
    const db = supabaseForUser(auth.token);

    // RLS decides whether this package belongs to the caller's tenant, so a
    // forged package id cannot place a file under someone else's prefix.
    const { data: pkg } = await db
      .from('work_package')
      .select('id')
      .eq('id', packageId)
      .maybeSingle();

    if (!pkg) {
      res.status(404).json({ error: 'No such package' });
      return;
    }

    await ensureBucket();

    const created: QuoteDocument[] = [];

    for (const file of files) {
      const filename = safeName(file.originalname);
      const path = `${auth.tenantId}/${packageId}/${Date.now()}-${filename}`;

      const { error: uploadError } = await supabaseAdmin.storage
        .from(BUCKET)
        .upload(path, file.buffer, {
          contentType: ALLOWED.get(extname(filename).toLowerCase()) ?? file.mimetype,
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

/** Packages the caller can upload against. Enough for the week-1 screens. */
documentsRouter.get('/packages', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { data, error } = await supabaseForUser(auth.token)
    .from('work_package')
    .select('id, name, status, csi_divisions, project_id')
    .order('name');

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json(data ?? []);
});
