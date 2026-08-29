import { apiPost } from './api';
import { supabase } from './supabase';

type DirectUpload = {
  /** Endpoint that mints a signed key, e.g. /projects/:id/documents/signed-upload */
  signPath: string;
  /** Endpoint that records the row once the bytes have landed. */
  confirmPath: string;
  file: File;
  extra?: Record<string, unknown>;
};

/**
 * Uploads straight to Supabase Storage rather than through the API.
 *
 * The server still mints the storage key — so the tenant prefix is not
 * negotiable — and still writes the database row, reading the object's real
 * size back from storage rather than trusting what the browser claims. What it
 * does not do is hold the file in memory, which is what made a large plan set
 * fall over.
 */
export async function directUpload<T>({
  signPath,
  confirmPath,
  file,
  extra,
}: DirectUpload): Promise<T> {
  const signed = await apiPost<{ bucket: string; path: string; token: string }>(signPath, {
    filename: file.name,
    ...extra,
  });

  const { error } = await supabase.storage
    .from(signed.bucket)
    .uploadToSignedUrl(signed.path, signed.token, file, {
      contentType: file.type || undefined,
    });

  if (error) {
    // Storage enforces the per-file ceiling independently of anything we check,
    // so say which limit was hit rather than surfacing a bare "failed".
    throw new Error(
      /exceeded|too large|maximum/i.test(error.message)
        ? `${file.name} is too large for the current Supabase plan (50MB per file).`
        : `${file.name}: ${error.message}`,
    );
  }

  return apiPost<T>(confirmPath, { path: signed.path, filename: file.name, ...extra });
}
