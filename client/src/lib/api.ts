import { supabase } from './supabase';

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function unwrap<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export async function apiGet<T>(path: string): Promise<T> {
  return unwrap<T>(await fetch(`/api${path}`, { headers: await authHeader() }));
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return unwrap<T>(
    await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify(body ?? {}),
    }),
  );
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return unwrap<T>(
    await fetch(`/api${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify(body),
    }),
  );
}

export async function apiDelete<T>(path: string): Promise<T> {
  return unwrap<T>(
    await fetch(`/api${path}`, { method: 'DELETE', headers: await authHeader() }),
  );
}

/** Multipart. Content-Type is left unset so the browser writes the boundary. */
export async function apiUpload<T>(path: string, files: File[]): Promise<T> {
  const form = new FormData();
  for (const file of files) form.append('files', file);

  return unwrap<T>(
    await fetch(`/api${path}`, { method: 'POST', headers: await authHeader(), body: form }),
  );
}

/** One file, under the field name `file` — what multer's `single()` expects.
 *  Separate from apiUpload because the two field names are not interchangeable
 *  and a mismatch fails as "No file was sent", which reads like a browser bug. */
export async function apiUploadOne<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);

  return unwrap<T>(
    await fetch(`/api${path}`, { method: 'POST', headers: await authHeader(), body: form }),
  );
}

/** Opens the SSE stream with an Authorization header, which EventSource cannot
 *  send — the alternative is a token in the query string, and tokens in URLs
 *  end up in logs and referrers. */
export async function openEventStream(
  path: string,
  signal: AbortSignal,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await fetch(`/api${path}`, { headers: await authHeader(), signal });
  if (!response.ok || !response.body) {
    throw new Error(`Could not open stream: ${response.status} ${response.statusText}`);
  }
  return response.body.getReader();
}
