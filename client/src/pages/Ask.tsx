import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ErrorBanner, Layout, fileSize } from '../components/Layout';
import { apiGet, apiPost } from '../lib/api';

type Thread = {
  id: string;
  title: string;
  project_id: string | null;
  divisions: string[];
  document_ids: string[];
  updated_at: string;
};

type Message = {
  id: string;
  seq: number;
  role: 'USER' | 'EXPERT';
  content: string;
  citations: { kind: string; ref: string }[];
  at: string;
};

type ProjectDoc = { id: string; filename: string; kind: string; size_bytes: number | null };
type Project = { id: string; name: string; bid_id: string };
type Division = { code: string; title: string };

type AskResult = {
  message: Message;
  attached: string[];
  skipped: string[];
  knowledge: { patterns: number; scopeItems: number; divisions: string[]; stubbed: boolean };
};

/**
 * Ask a division expert.
 *
 * The expert is a specialist prompt over retrieved knowledge — gap patterns for
 * the divisions in play, the project's scope baseline, and any documents you
 * point it at. Pointing it at a document is what makes it useful rather than a
 * novelty: "does this spec call for a backflow preventer, and is it in my
 * scope?" is a question about two specific files.
 */
export function AskPage() {
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project') ?? '';

  const [projects, setProjects] = useState<Project[]>([]);
  const [divisions, setDivisions] = useState<Division[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [documents, setDocuments] = useState<ProjectDoc[]>([]);
  const [attached, setAttached] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [question, setQuestion] = useState('');
  const [thinking, setThinking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    Promise.all([apiGet<Project[]>('/projects'), apiGet<Division[]>('/divisions')])
      .then(([p, d]) => {
        setProjects(p);
        setDivisions(d);
      })
      .catch((caught: Error) => setError(caught.message));
  }, []);

  const loadThreads = useCallback(async () => {
    const rows = await apiGet<Thread[]>(
      projectId ? `/consult/threads?projectId=${projectId}` : '/consult/threads',
    );
    setThreads(rows);
  }, [projectId]);

  useEffect(() => {
    loadThreads().catch((caught: Error) => setError(caught.message));
  }, [loadThreads]);

  useEffect(() => {
    if (!projectId) {
      setDocuments([]);
      return;
    }
    apiGet<ProjectDoc[]>(`/consult/documents?projectId=${projectId}`)
      .then(setDocuments)
      .catch(() => setDocuments([]));
  }, [projectId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, thinking]);

  async function openThread(id: string) {
    setError(null);
    try {
      const data = await apiGet<{ thread: Thread; messages: Message[] }>(
        `/consult/threads/${id}`,
      );
      setThreadId(id);
      setMessages(data.messages);
      setAttached(new Set(data.thread.document_ids));
      setPicked(new Set(data.thread.divisions));
      if (data.thread.project_id) setParams({ project: data.thread.project_id });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function ask(event: FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (!text || thinking) return;

    setThinking(true);
    setError(null);
    setNotice(null);
    setQuestion('');

    // Show the question straight away; the answer takes a moment.
    const optimistic: Message = {
      id: `local-${Date.now()}`,
      seq: messages.length + 1,
      role: 'USER',
      content: text,
      citations: [],
      at: new Date().toISOString(),
    };
    setMessages((current) => [...current, optimistic]);

    try {
      let id = threadId;
      if (!id) {
        const thread = await apiPost<Thread>('/consult/threads', {
          projectId: projectId || undefined,
          divisions: [...picked],
          documentIds: [...attached],
        });
        id = thread.id;
        setThreadId(id);
      }

      const result = await apiPost<AskResult>(`/consult/threads/${id}/ask`, {
        question: text,
        divisions: [...picked],
        documentIds: [...attached],
      });

      setMessages((current) => [...current, result.message]);

      const notes: string[] = [];
      if (result.attached.length > 0) notes.push(`Read ${result.attached.join(', ')}.`);
      if (result.skipped.length > 0) notes.push(`Skipped ${result.skipped.join('; ')}.`);
      if (result.knowledge.stubbed) {
        notes.push(
          'Reasoning against placeholder gap patterns — these divisions are still SEED_STUB.',
        );
      }
      setNotice(notes.join(' ') || null);
      await loadThreads();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setMessages((current) => current.filter((message) => message.id !== optimistic.id));
      setQuestion(text);
    } finally {
      setThinking(false);
    }
  }

  const toggle = (set: Set<string>, value: string, apply: (next: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    apply(next);
  };

  return (
    <Layout breadcrumb={<span>Ask a division expert</span>}>
      <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
        {/* ------------------------------------------------ conversations */}
        <aside className="space-y-3">
          <button
            onClick={() => {
              setThreadId(null);
              setMessages([]);
              setNotice(null);
            }}
            className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white"
          >
            New question
          </button>

          <div className="space-y-1">
            {threads.map((thread) => (
              <button
                key={thread.id}
                onClick={() => void openThread(thread.id)}
                className={`block w-full rounded px-2 py-1.5 text-left text-xs ${
                  thread.id === threadId
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                <span className="line-clamp-2">{thread.title}</span>
              </button>
            ))}
            {threads.length === 0 && (
              <p className="px-2 text-xs text-slate-400">No questions yet.</p>
            )}
          </div>
        </aside>

        {/* --------------------------------------------------------- chat */}
        <div className="space-y-4">
          <ErrorBanner message={error} />

          <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-slate-600">Project</span>
              <select
                value={projectId}
                onChange={(event) =>
                  event.target.value ? setParams({ project: event.target.value }) : setParams({})
                }
                className="rounded-md border border-slate-300 px-2 py-1 text-xs"
              >
                <option value="">none — general knowledge only</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.bid_id} · {project.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <span className="text-xs font-medium text-slate-600">Divisions</span>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {divisions.map((division) => (
                  <button
                    key={division.code}
                    onClick={() => toggle(picked, division.code, setPicked)}
                    title={division.title}
                    className={`rounded border px-1.5 py-0.5 font-mono text-xs ${
                      picked.has(division.code)
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-300 text-slate-600'
                    }`}
                  >
                    {division.code}
                  </button>
                ))}
              </div>
              {picked.size === 0 && (
                <p className="mt-1 text-xs text-slate-400">
                  None selected — every division's patterns are in scope.
                </p>
              )}
            </div>

            {documents.length > 0 && (
              <div>
                <span className="text-xs font-medium text-slate-600">
                  Point it at a file{' '}
                  <span className="font-normal text-slate-400">
                    (PDFs, up to 5 files / 20MB)
                  </span>
                </span>
                <div className="mt-1.5 max-h-32 space-y-0.5 overflow-y-auto">
                  {documents.map((document) => (
                    <label
                      key={document.id}
                      className="flex items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-slate-50"
                    >
                      <input
                        type="checkbox"
                        checked={attached.has(document.id)}
                        onChange={() => toggle(attached, document.id, setAttached)}
                      />
                      <span className="text-slate-700">{document.filename}</span>
                      <span className="text-slate-400">
                        {document.kind.toLowerCase()} · {fileSize(document.size_bytes)}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            {projectId && documents.length === 0 && (
              <p className="text-xs text-slate-400">
                No documents on this project yet — upload drawings or specs on the project's
                Documents tab and they become attachable here.
              </p>
            )}
          </div>

          <div className="min-h-[16rem] space-y-4">
            {messages.length === 0 && !thinking && (
              <div className="rounded-lg border border-slate-200 bg-white px-4 py-8 text-sm text-slate-500">
                <p className="mb-2 font-medium text-slate-700">Try asking:</p>
                <ul className="space-y-1 text-slate-500">
                  <li>“Does this spec call for a backflow preventer, and is it in my scope?”</li>
                  <li>“What does division 22 usually leave out that bites on a residential ADU?”</li>
                  <li>“Two subs both assume the other carries the trenching. Who normally does?”</li>
                </ul>
              </div>
            )}

            {messages.map((message) => (
              <div
                key={message.id}
                className={
                  message.role === 'USER'
                    ? 'ml-auto max-w-2xl rounded-lg bg-slate-900 px-4 py-2.5 text-sm text-white'
                    : 'max-w-3xl rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800'
                }
              >
                <div className="whitespace-pre-wrap leading-relaxed">{message.content}</div>

                {message.role === 'EXPERT' && message.citations.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1 border-t border-slate-100 pt-2">
                    {message.citations.map((citation, index) => (
                      <span
                        key={index}
                        className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600"
                      >
                        {citation.kind === 'gap_pattern' && 'pattern '}
                        {citation.kind === 'page' && 'p.'}
                        {citation.ref}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {thinking && (
              <div className="max-w-3xl rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-400">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500" />{' '}
                reading{attached.size > 0 ? ` ${attached.size} document(s)` : ''}…
              </div>
            )}
            <div ref={bottom} />
          </div>

          {notice && <p className="text-xs text-slate-500">{notice}</p>}

          <form onSubmit={ask} className="flex gap-2">
            <input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Ask the expert…"
              className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900"
            />
            <button
              type="submit"
              disabled={thinking || question.trim() === ''}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              Ask
            </button>
          </form>

          <p className="text-xs text-slate-400">
            The expert cites what it used — a gap pattern, a scope id, or a page. It will not give
            you a dollar figure: costing has its own step and its own rules.
          </p>
        </div>
      </div>
    </Layout>
  );
}
