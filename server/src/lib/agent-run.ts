import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from './supabase.js';

export type FillTag = 'S' | 'AI' | 'H' | 'L';

export type DraftInput = {
  targetTable: string;
  targetId?: string | null;
  field: string;
  value: unknown;
  sourceFileId?: string | null;
  /** Page plus excerpt. R6: cite or stay silent. */
  sourceLocation?: string | null;
  confidence?: number | null;
  fillTag: FillTag;
};

/**
 * Everything an agent is allowed to do.
 *
 * There is deliberately no Supabase client here and no method that writes a
 * canonical row. An agent narrates (emit) and proposes (draft); promotion to
 * state is a separate, human-attributed act (R2). The restriction is expressed
 * in this type rather than in a comment, so an agent that tries to write state
 * does not compile.
 */
export type AgentContext = {
  readonly runId: string;
  readonly tenantId: string;
  emit(eventType: AgentEventType, message: string, payload?: unknown): Promise<void>;
  draft(input: DraftInput): Promise<void>;
  /** Reads one row. Reading is not the R2 concern; writing is. */
  read<T = Record<string, unknown>>(table: string, id: string): Promise<T | null>;
  /** Reads a stored document's bytes. */
  readFile(bucket: string, path: string): Promise<Buffer | null>;
  /**
   * Records what sheets a drawing set contains.
   *
   * The one write of canonical state an agent is trusted with, and it is
   * narrow on purpose. A sheet number read off a title block is the same kind
   * of fact as a page count or a file size: it is what the document IS, not a
   * judgement about what it means. Nothing downstream is decided by it — it
   * exists so a citation can say "A-201" instead of "page 47", which is what
   * R6 actually requires to be useful.
   *
   * Note the shape of the escape hatch: a method that can only write sheets,
   * not a database client. An agent still cannot draft a scope item into
   * existence, and the type is what stops it.
   */
  recordSheets(documentId: string, sheets: SheetIndexRow[]): Promise<number>;
};

export type SheetIndexRow = {
  pageNumber: number;
  sheetNumber: string | null;
  sheetTitle: string | null;
  discipline: string | null;
  confidence: number | null;
};

/**
 * INFO reads as normal weight in the activity stream; WARNING is the amber line
 * that makes an estimator look up. Reserve it for findings — an exclusion, an
 * uncovered scope item, a value that could not be established.
 */
export type AgentEventType = 'INFO' | 'WARNING' | 'ERROR' | 'RESULT';

type StartOptions = {
  tenantId: string;
  agentType: string;
  projectId?: string | null;
  inputRef?: string | null;
  model?: string | null;
  promptVersion?: string | null;
};

/**
 * Owns an agent_run row and the evidence written under it. Constructed by the
 * worker, never by a request handler — a long run must not sit behind an HTTP
 * connection.
 */
export class AgentRun implements AgentContext {
  private seq = 0;

  private constructor(
    readonly runId: string,
    readonly tenantId: string,
    private readonly db: SupabaseClient,
  ) {}

  static async start(options: StartOptions): Promise<AgentRun> {
    const { data, error } = await supabaseAdmin
      .from('agent_run')
      .insert({
        tenant_id: options.tenantId,
        agent_type: options.agentType,
        project_id: options.projectId ?? null,
        input_ref: options.inputRef ?? null,
        status: 'RUNNING',
        model: options.model ?? null,
        prompt_version: options.promptVersion ?? null,
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error || !data) {
      throw new Error(`Could not start agent run: ${error?.message ?? 'no row returned'}`);
    }
    return new AgentRun(data.id, options.tenantId, supabaseAdmin);
  }

  /**
   * Picks up a run created earlier — the row exists from the moment work is
   * enqueued, so the client can open the activity stream before a worker has
   * even claimed the job, rather than polling to discover a run id.
   *
   * Resumes the sequence from whatever is already there, so a retried job
   * appends to the narration instead of colliding with it.
   */
  static async resume(runId: string, tenantId: string): Promise<AgentRun> {
    const run = new AgentRun(runId, tenantId, supabaseAdmin);

    const { data } = await supabaseAdmin
      .from('agent_event')
      .select('seq')
      .eq('agent_run_id', runId)
      .order('seq', { ascending: false })
      .limit(1)
      .maybeSingle();

    run.seq = data?.seq ?? 0;

    await supabaseAdmin
      .from('agent_run')
      .update({ status: 'RUNNING', started_at: new Date().toISOString() })
      .eq('id', runId);

    return run;
  }

  /** One line in the activity stream. Sequential, so a reader can resume. */
  async emit(eventType: AgentEventType, message: string, payload?: unknown): Promise<void> {
    this.seq += 1;
    const { error } = await this.db.from('agent_event').insert({
      tenant_id: this.tenantId,
      agent_run_id: this.runId,
      seq: this.seq,
      event_type: eventType,
      message,
      payload: payload === undefined ? null : payload,
    });
    if (error) throw new Error(`Could not emit agent event: ${error.message}`);
  }

  /** Proposes a value. Immutable once written; a human promotes it, or not. */
  async draft(input: DraftInput): Promise<void> {
    const { error } = await this.db.from('draft').insert({
      tenant_id: this.tenantId,
      agent_run_id: this.runId,
      target_table: input.targetTable,
      target_id: input.targetId ?? null,
      field: input.field,
      proposed_value: input.value === undefined ? null : input.value,
      source_file_id: input.sourceFileId ?? null,
      source_location: input.sourceLocation ?? null,
      confidence: input.confidence ?? null,
      fill_tag: input.fillTag,
    });
    if (error) throw new Error(`Could not write draft: ${error.message}`);
  }

  /** Read-only. An agent needs to see its inputs; it still cannot write state. */
  async read<T = Record<string, unknown>>(table: string, id: string): Promise<T | null> {
    const { data } = await this.db.from(table).select('*').eq('id', id).maybeSingle();
    return (data as T | null) ?? null;
  }

  async readFile(bucket: string, path: string): Promise<Buffer | null> {
    const { data, error } = await this.db.storage.from(bucket).download(path);
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  }

  /** See the note on AgentContext.recordSheets for why this exists at all. */
  async recordSheets(documentId: string, sheets: SheetIndexRow[]): Promise<number> {
    if (sheets.length === 0) return 0;

    // Re-indexing replaces the previous read of the file rather than layering
    // a second opinion on top of it.
    await this.db.from('document_sheet').delete().eq('document_id', documentId);

    const { error } = await this.db.from('document_sheet').insert(
      sheets.map((sheet) => ({
        tenant_id: this.tenantId,
        document_id: documentId,
        page_number: sheet.pageNumber,
        sheet_number: sheet.sheetNumber,
        sheet_title: sheet.sheetTitle,
        discipline: sheet.discipline,
        confidence: sheet.confidence,
      })),
    );
    if (error) throw new Error(`Could not write the sheet index: ${error.message}`);

    await this.db
      .from('project_document')
      .update({ indexed_at: new Date().toISOString() })
      .eq('id', documentId);

    return sheets.length;
  }

  async finish(status: 'DONE' | 'FAILED', tokenCost?: number): Promise<void> {
    await this.db
      .from('agent_run')
      .update({
        status,
        finished_at: new Date().toISOString(),
        ...(tokenCost === undefined ? {} : { token_cost: tokenCost }),
      })
      .eq('id', this.runId);
  }
}
