import { apiPost } from './api';

type DirectUpload = {
  /** Endpoint that mints a signed key, e.g. /projects/:id/documents/signed-upload */
  signPath: string;
  /** Endpoint that records the row once the bytes have landed. */
  confirmPath: string;
  file: File;
  extra?: Record<string, unknown>;
  /** 0–1. Called as the bytes go up. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
};

const STORAGE_URL = `${import.meta.env.VITE_SUPABASE_URL}/storage/v1`;

/**
 * PUTs the bytes to a signed storage URL, reporting progress as it goes.
 *
 * This is what supabase-js's uploadToSignedUrl does internally, written out
 * because that method gives no way to observe the upload. `fetch` cannot report
 * request progress at all, so this is XHR — the one thing it still does that
 * fetch does not.
 *
 * A plan set is hundreds of megabytes. A spinner that sits there for four
 * minutes is indistinguishable from one that has hung, and the estimator's
 * reasonable response is to reload the page halfway through.
 */
function putWithProgress(
  url: string,
  file: File,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();

    // The multipart shape the storage API expects: the file under an empty
    // field name, with cacheControl alongside it.
    const body = new FormData();
    body.append('cacheControl', '3600');
    body.append('', file);

    request.open('PUT', url);
    request.setRequestHeader('x-upsert', 'false');

    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    });

    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress?.(1);
        resolve();
        return;
      }

      let message = `${request.status} ${request.statusText}`;
      try {
        const parsed = JSON.parse(request.responseText) as { message?: string; error?: string };
        message = parsed.message ?? parsed.error ?? message;
      } catch {
        // A non-JSON body is a proxy or gateway talking, not storage. The
        // status line is the most useful thing left to say.
      }

      // Storage enforces the per-file ceiling independently of anything we
      // check, so say which limit was hit rather than surfacing a bare failure.
      reject(
        new Error(
          /exceeded|too large|maximum|413/i.test(message)
            ? `${file.name} exceeds the storage size limit for this project.`
            : `${file.name}: ${message}`,
        ),
      );
    });

    request.addEventListener('error', () =>
      reject(new Error(`${file.name}: the upload failed before it reached storage.`)),
    );
    request.addEventListener('abort', () => reject(new Error(`${file.name}: cancelled.`)));

    signal?.addEventListener('abort', () => request.abort(), { once: true });

    request.send(body);
  });
}

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
  onProgress,
  signal,
}: DirectUpload): Promise<T> {
  const signed = await apiPost<{ bucket: string; path: string; token: string }>(signPath, {
    filename: file.name,
    ...extra,
  });

  const url = `${STORAGE_URL}/object/upload/sign/${signed.bucket}/${signed.path}?token=${encodeURIComponent(signed.token)}`;

  await putWithProgress(url, file, onProgress, signal);

  return apiPost<T>(confirmPath, { path: signed.path, filename: file.name, ...extra });
}

export type UploadState = {
  id: string;
  file: File;
  /** 0–1 while uploading; 1 once storage has it. */
  progress: number;
  status: 'QUEUED' | 'UPLOADING' | 'RECORDING' | 'DONE' | 'FAILED' | 'CANCELLED';
  error: string | null;
};

/**
 * How many files go up at once.
 *
 * Three rather than one because a bid set is dozens of files and serialising
 * them wastes most of the connection; three rather than ten because browsers
 * cap concurrent connections per host anyway, and a queue that looks like it
 * started ten uploads while eight sit blocked is a progress bar that lies.
 */
const CONCURRENCY = 3;

/**
 * Uploads a batch, reporting each file's progress independently.
 *
 * One file failing does not stop the rest. Dropping forty files and having the
 * thirty-ninth kill the batch is the behaviour that makes people upload one at
 * a time forever after.
 */
export async function uploadBatch<T>(
  files: File[],
  options: {
    signPath: string;
    confirmPath: string;
    extra?: Record<string, unknown>;
    onChange: (states: UploadState[]) => void;
    signal?: AbortSignal;
  },
): Promise<{ done: T[]; failed: UploadState[] }> {
  const states: UploadState[] = files.map((file, index) => ({
    id: `${index}-${file.name}-${file.size}`,
    file,
    progress: 0,
    status: 'QUEUED',
    error: null,
  }));

  const publish = () => options.onChange([...states]);
  publish();

  const done: T[] = [];
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= states.length) return;

      const state = states[index];
      if (!state) return;

      if (options.signal?.aborted) {
        state.status = 'CANCELLED';
        publish();
        continue;
      }

      state.status = 'UPLOADING';
      publish();

      try {
        const record = await directUpload<T>({
          signPath: options.signPath,
          confirmPath: options.confirmPath,
          file: state.file,
          extra: options.extra,
          signal: options.signal,
          onProgress: (fraction) => {
            state.progress = fraction;
            // The row is written after the bytes land, so a file sitting at
            // 100% is not yet finished. Say which of the two it is waiting on.
            if (fraction >= 1 && state.status === 'UPLOADING') state.status = 'RECORDING';
            publish();
          },
        });

        done.push(record);
        state.progress = 1;
        state.status = 'DONE';
      } catch (caught) {
        state.status = 'FAILED';
        state.error = caught instanceof Error ? caught.message : String(caught);
      }
      publish();
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, states.length) }, () => worker()),
  );

  return { done, failed: states.filter((state) => state.status === 'FAILED') };
}
