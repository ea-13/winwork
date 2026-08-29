import Anthropic from '@anthropic-ai/sdk';
import { Router } from 'express';
import { MODEL, askExpert } from '../lib/anthropic.js';
import { supabaseAdmin, supabaseForUser } from '../lib/supabase.js';

export const consultRouter = Router();

export const CONSULT_CHAT_VERSION = 'expert-chat-1';

/** Attaching a whole plan set would blow the request limit; five is generous. */
const MAX_DOCUMENTS = 5;
const MAX_ATTACHED_BYTES = 20 * 1024 * 1024;

/**
 * Asking a division expert.
 *
 * The expert is a specialist prompt plus retrieved knowledge, not a fine-tuned
 * model — knowledge that stays editable, and every claim able to cite where it
 * came from. What gets retrieved: the gap patterns for the divisions in play,
 * the project's scope baseline if there is one, and any documents the estimator
 * pointed at.
 *
 * Pointing at a file is the part that makes this useful rather than a novelty.
 * "Does this spec require a backflow preventer, and is it in my scope?" is a
 * question about two specific documents, and an expert that cannot read them is
 * just a search engine with opinions.
 */

type ThreadRow = {
  id: string;
  project_id: string | null;
  divisions: string[];
  document_ids: string[];
  mode: 'EXPERT' | 'DOCUMENT';
};

consultRouter.get('/consult/threads', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const query = supabaseForUser(auth.token)
    .from('consult_thread')
    .select('id, title, project_id, divisions, document_ids, mode, updated_at')
    .order('updated_at', { ascending: false })
    .limit(50);

  const { data, error } = typeof req.query.projectId === 'string'
    ? await query.eq('project_id', req.query.projectId)
    : await query;

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json(data ?? []);
});

consultRouter.get('/consult/threads/:threadId', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const db = supabaseForUser(auth.token);
  const [{ data: thread }, { data: messages }] = await Promise.all([
    db.from('consult_thread').select('*').eq('id', req.params.threadId ?? '').maybeSingle(),
    db
      .from('consult_message')
      .select('id, seq, role, content, citations, model, at')
      .eq('thread_id', req.params.threadId ?? '')
      .order('seq'),
  ]);

  if (!thread) {
    res.status(404).json({ error: 'No such conversation' });
    return;
  }
  res.json({ thread, messages: messages ?? [] });
});

consultRouter.post('/consult/threads', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const { data, error } = await supabaseForUser(auth.token)
    .from('consult_thread')
    .insert({
      tenant_id: auth.tenantId,
      project_id: typeof body.projectId === 'string' ? body.projectId : null,
      title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'New question',
      divisions: Array.isArray(body.divisions) ? body.divisions : [],
      document_ids: Array.isArray(body.documentIds) ? body.documentIds : [],
      mode: body.mode === 'DOCUMENT' ? 'DOCUMENT' : 'EXPERT',
      created_by: auth.userId,
    })
    .select('*')
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.status(201).json(data);
});

/**
 * Ask a question. Returns the expert's answer with its citations.
 *
 * Synchronous rather than queued: a question is a conversation, and a
 * conversation that goes through a job queue is not one. Long document reads
 * are the exception, and the attachment cap keeps this inside a request.
 */
consultRouter.post('/consult/threads/:threadId/ask', async (req, res) => {
  const threadId = req.params.threadId ?? '';
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) {
    res.status(400).json({ error: 'A question is required' });
    return;
  }

  const db = supabaseForUser(auth.token);

  const { data: thread } = await db
    .from('consult_thread')
    .select('id, project_id, divisions, document_ids, mode')
    .eq('id', threadId)
    .maybeSingle();

  if (!thread) {
    res.status(404).json({ error: 'No such conversation' });
    return;
  }

  const row = thread as ThreadRow;

  // Whatever the caller attached this turn is added to the thread, so a follow
  // up question keeps the same documents in view.
  const attachedNow = Array.isArray(body.documentIds)
    ? (body.documentIds as unknown[]).filter((id): id is string => typeof id === 'string')
    : [];
  const documentIds = [...new Set([...row.document_ids, ...attachedNow])].slice(0, MAX_DOCUMENTS);

  const divisions = Array.isArray(body.divisions) && body.divisions.length > 0
    ? (body.divisions as string[])
    : row.divisions;

  const mode: 'EXPERT' | 'DOCUMENT' =
    body.mode === 'DOCUMENT' || body.mode === 'EXPERT' ? body.mode : row.mode;

  // Reading documents with no documents attached is a question with no
  // material. Say so rather than quietly answering from general knowledge.
  if (mode === 'DOCUMENT' && documentIds.length === 0) {
    res.status(400).json({
      error: 'Reading mode needs at least one document attached. Tick a file, or switch to the expert.',
    });
    return;
  }

  // ------------------------------------------------------------- retrieval

  const { data: experts } = divisions.length
    ? await db.from('division_expert').select('id, csi_division, title, status').in('csi_division', divisions)
    : await db.from('division_expert').select('id, csi_division, title, status');

  const expertIds = (experts ?? []).map((expert) => expert.id as string);
  const divisionOf = new Map((experts ?? []).map((e) => [e.id as string, e.csi_division as string]));

  const { data: patterns } = expertIds.length
    ? await db
        .from('gap_pattern')
        .select('id, division_expert_id, pattern_text, typical_csi_section, is_frequent_change_order')
        .in('division_expert_id', expertIds)
    : { data: [] as Record<string, unknown>[] };

  const { data: scope } = row.project_id
    ? await db
        .from('scope_item')
        .select('scope_id, csi_section, title, description, unit, quantity, is_locked')
        .eq('project_id', row.project_id)
    : { data: [] as Record<string, unknown>[] };

  const { data: documents } = documentIds.length
    ? await db
        .from('project_document')
        .select('id, filename, kind, storage_path, size_bytes')
        .in('id', documentIds)
    : { data: [] as Record<string, unknown>[] };

  // Fetch attached PDFs, newest-first, stopping at the size cap.
  const attachments: { filename: string; bytes: Buffer }[] = [];
  let attachedBytes = 0;
  const skipped: string[] = [];

  for (const document of documents ?? []) {
    const filename = String(document.filename ?? '');
    if (!filename.toLowerCase().endsWith('.pdf')) {
      skipped.push(`${filename} (only PDFs can be read)`);
      continue;
    }
    const size = Number(document.size_bytes ?? 0);
    if (attachedBytes + size > MAX_ATTACHED_BYTES) {
      skipped.push(`${filename} (would exceed the ${MAX_ATTACHED_BYTES / 1024 / 1024}MB attachment limit)`);
      continue;
    }
    const { data: file } = await supabaseAdmin.storage
      .from('project-documents')
      .download(String(document.storage_path));
    if (!file) {
      skipped.push(`${filename} (could not be downloaded)`);
      continue;
    }
    attachments.push({ filename, bytes: Buffer.from(await file.arrayBuffer()) });
    attachedBytes += size;
  }

  // --------------------------------------------------------------- history

  const { data: history } = await db
    .from('consult_message')
    .select('seq, role, content')
    .eq('thread_id', threadId)
    .order('seq');

  const nextSeq = (history ?? []).reduce((max, m) => Math.max(max, Number(m.seq)), 0) + 1;

  await db.from('consult_message').insert({
    tenant_id: auth.tenantId,
    thread_id: threadId,
    seq: nextSeq,
    role: 'USER',
    content: question,
  });

  // ------------------------------------------------------------------ ask

  try {
    const answer = await askExpert({
      question,
      mode,
      divisions,
      patterns: (patterns ?? []).map((pattern) => ({
        id: String(pattern.id),
        division: divisionOf.get(String(pattern.division_expert_id)) ?? '',
        text: String(pattern.pattern_text),
        section: pattern.typical_csi_section as string | null,
        frequentChangeOrder: Boolean(pattern.is_frequent_change_order),
      })),
      scope: (scope ?? []).map((item) => ({
        scopeId: String(item.scope_id),
        section: item.csi_section as string | null,
        title: String(item.title),
        description: item.description as string | null,
        quantity: item.quantity as number | null,
        unit: item.unit as string | null,
        locked: Boolean(item.is_locked),
      })),
      attachments,
      history: (history ?? []).map((message) => ({
        role: message.role === 'USER' ? ('user' as const) : ('assistant' as const),
        content: String(message.content),
      })),
    });

    const { data: written } = await db
      .from('consult_message')
      .insert({
        tenant_id: auth.tenantId,
        thread_id: threadId,
        seq: nextSeq + 1,
        role: 'EXPERT',
        content: answer.text,
        citations: answer.citations,
        model: MODEL,
        prompt_version: CONSULT_CHAT_VERSION,
        token_cost: answer.costUsd,
      })
      .select('id, seq, role, content, citations, model, at')
      .single();

    await db
      .from('consult_thread')
      .update({
        document_ids: documentIds,
        divisions,
        mode,
        updated_at: new Date().toISOString(),
        // First question becomes the thread's name, so a list of threads reads.
        ...(nextSeq === 1 ? { title: question.slice(0, 80) } : {}),
      })
      .eq('id', threadId);

    res.json({
      message: written,
      attached: attachments.map((attachment) => attachment.filename),
      skipped,
      knowledge: {
        patterns: (patterns ?? []).length,
        scopeItems: (scope ?? []).length,
        divisions,
        // Said plainly: the expert is reasoning against stubs until the real
        // playbooks are loaded, and an estimator should know that.
        stubbed: (experts ?? []).every((expert) => expert.status === 'SEED_STUB'),
      },
    });
  } catch (caught) {
    res.status(500).json({
      error: caught instanceof Error ? caught.message : String(caught),
    });
  }
});

/** Documents on a project, so the chat can offer them as attachments. */
consultRouter.get('/consult/documents', async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }

  const { data } = await supabaseForUser(auth.token)
    .from('project_document')
    .select('id, filename, kind, size_bytes')
    .eq('project_id', projectId)
    .order('uploaded_at', { ascending: false });

  res.json(data ?? []);
});

export type { Anthropic };
