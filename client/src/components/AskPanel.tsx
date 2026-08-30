import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { apiGet, apiPost } from '../lib/api';

type Message = {
  id: string;
  seq: number;
  role: 'USER' | 'EXPERT';
  content: string;
  citations: { kind: string; ref: string }[];
};

type Thread = { id: string; title: string };
type ProjectDoc = { id: string; filename: string; kind: string };
type Division = { code: string; title: string };

/** Every trade, plus the one that means "do not narrow it". */
const GENERAL = '__general__';

/**
 * Ask an expert, from wherever you are.
 *
 * It was its own page, which was the wrong shape for what it is. The question
 * an estimator wants to ask — "who normally carries the head-of-wall detail" —
 * arrives while they are looking at the scope item that prompted it, and making
 * them leave the screen to ask means the answer arrives with the context gone.
 *
 * So it docks. It knows which project is open, attaches that project's
 * documents, and the conversation persists exactly as it did before — the same
 * threads, the same citations, the same corpus (P28).
 */
export function AskPanel({ projectId }: { projectId: string | null }) {
  const [open, setOpen] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [documents, setDocuments] = useState<ProjectDoc[]>([]);
  const [divisions, setDivisions] = useState<Division[]>([]);
  const [division, setDivision] = useState<string>(GENERAL);
  const [docsOpen, setDocsOpen] = useState(false);
  const [attached, setAttached] = useState<Set<string>>(new Set());
  // PROJECT is the assistant that can read the project and run things.
  // EXPERT reasons about the trade; DOCUMENT answers from the files.
  const [mode, setMode] = useState<'PROJECT' | 'EXPERT' | 'DOCUMENT'>('PROJECT');
  const [question, setQuestion] = useState('');
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    apiGet<Division[]>('/divisions').then(setDivisions).catch(() => setDivisions([]));
  }, [open]);

  useEffect(() => {
    if (!open || !projectId) return;
    apiGet<ProjectDoc[]>(`/consult/documents?projectId=${projectId}`)
      .then(setDocuments)
      .catch(() => setDocuments([]));
  }, [open, projectId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, thinking]);

  const ask = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const text = question.trim();
      if (text === '' || thinking) return;

      setThinking(true);
      setError(null);
      setQuestion('');

      // Snapshot before the optimistic message goes in, so the history sent is
      // the real conversation and not one with this turn duplicated.
      const priorTurns = messages.map((message) => ({
        role: message.role === 'USER' ? ('user' as const) : ('assistant' as const),
        content: message.content,
      }));

      // Optimistic, so the question is on screen while the answer is composed.
      setMessages((current) => [
        ...current,
        { id: `local-${current.length}`, seq: current.length, role: 'USER', content: text, citations: [] },
      ]);

      try {
        // The project assistant is a different thing from the expert: it holds
        // tools over this project's real data, so it does not need a thread of
        // retrieved knowledge — it goes and looks.
        if (mode === 'PROJECT') {
          if (!projectId) {
            setError('Open a project first — this mode answers from the project itself.');
            return;
          }

          const result = await apiPost<{ reply: string; toolsUsed: { tool: string }[] }>(
            `/projects/${projectId}/chat`,
            { messages: [...priorTurns, { role: 'user' as const, content: text }] },
          );

          setMessages((current) => [
            ...current,
            {
              id: `reply-${current.length}`,
              seq: current.length,
              role: 'EXPERT',
              content: result.reply,
              citations: (result.toolsUsed ?? []).map((entry) => ({
                kind: 'read',
                ref: entry.tool.replace(/^get_|^run_/, ''),
              })),
            },
          ]);
          return;
        }

        let id = threadId;
        if (!id) {
          const thread = await apiPost<Thread>('/consult/threads', {
            projectId,
            title: text.slice(0, 60),
            documentIds: [...attached],
            divisions: division === GENERAL ? [] : [division],
          });
          id = thread.id;
          setThreadId(id);
        }

        const result = await apiPost<{ messages: Message[] }>(`/consult/threads/${id}/ask`, {
          question: text,
          mode,
          documentIds: [...attached],
          // General means every division, which is what an expert who has not
          // been told a trade should reason across.
          divisions: division === GENERAL ? [] : [division],
        });

        const data = await apiGet<{ thread: Thread; messages: Message[] }>(
          `/consult/threads/${id}`,
        );
        setMessages(data.messages ?? result.messages ?? []);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setThinking(false);
      }
    },
    [question, thinking, threadId, projectId, attached, mode, division, messages],
  );

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-40 rounded-full bg-ink-900 px-4 py-2.5 text-xs font-medium text-white shadow-lg hover:bg-ink-800"
      >
        Ask an expert
      </button>
    );
  }

  return (
    <aside className="fixed bottom-0 right-0 z-40 flex h-[70vh] w-[26rem] max-w-[95vw] flex-col rounded-tl-lg border-l border-t border-ink-300 bg-white shadow-2xl">
      <header className="flex items-center justify-between border-b border-ink-200 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-ink-900">Ask an expert</span>
          <div className="flex rounded border border-ink-300 text-[11px]">
            {([
              ['PROJECT', 'project', 'Reads this project and can run the agents'],
              ['EXPERT', 'trade', 'Reasons from division knowledge and gap patterns'],
              ['DOCUMENT', 'docs', 'Answers only from the attached documents'],
            ] as const).map(([option, label, hint]) => (
              <button
                key={option}
                onClick={() => setMode(option)}
                className={`px-1.5 py-0.5 ${
                  mode === option ? 'bg-ink-900 text-white' : 'text-ink-500'
                }`}
                title={hint}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-ink-400">
          {messages.length > 0 && (
            <button
              onClick={() => {
                setThreadId(null);
                setMessages([]);
              }}
              className="hover:text-ink-700"
            >
              new
            </button>
          )}
          <button onClick={() => setOpen(false)} className="hover:text-ink-700">
            close
          </button>
        </div>
      </header>

      <div className="flex items-center gap-2 border-b border-ink-200 px-3 py-1.5">
        {/* The trade, or General. The expert reasons across every division when
            you have not narrowed it, which is the honest default — most
            questions are not about one trade. */}
        <select
          value={division}
          onChange={(event) => setDivision(event.target.value)}
          className="min-w-0 flex-1 rounded border border-ink-300 px-1.5 py-1 text-[11px] outline-none focus:border-ink-800"
          title="Which trade should the expert reason as?"
        >
          <option value={GENERAL}>General — all trades</option>
          {divisions.map((entry) => (
            <option key={entry.code} value={entry.code}>
              {entry.code} · {entry.title}
            </option>
          ))}
        </select>

        {/* Documents as a multi-select of everything on this project, rather
            than the first eight as chips. A bid set is forty files and the one
            you want is rarely in the first eight. */}
        <div className="relative shrink-0">
          <button
            onClick={() => setDocsOpen((value) => !value)}
            disabled={documents.length === 0}
            className="rounded border border-ink-300 px-2 py-1 text-[11px] text-ink-700 disabled:opacity-40"
            title={documents.length === 0 ? 'No documents on this project yet' : 'Attach documents'}
          >
            {attached.size > 0 ? `${attached.size} doc${attached.size === 1 ? '' : 's'}` : 'Docs'} ▾
          </button>

          {docsOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setDocsOpen(false)} />
              <div className="absolute bottom-full right-0 z-50 mb-1 max-h-72 w-72 overflow-y-auto rounded-lg border border-ink-200 bg-white py-1 shadow-lg">
                <div className="flex items-center justify-between px-2 py-1">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-ink-400">
                    {documents.length} file{documents.length === 1 ? '' : 's'}
                  </span>
                  {attached.size > 0 && (
                    <button
                      onClick={() => setAttached(new Set())}
                      className="text-[10px] text-ink-400 hover:text-ink-700"
                    >
                      clear
                    </button>
                  )}
                </div>
                {documents.map((document) => (
                  <label
                    key={document.id}
                    className="flex cursor-pointer items-start gap-2 px-2 py-1 text-[11px] hover:bg-ink-50"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={attached.has(document.id)}
                      onChange={() =>
                        setAttached((current) => {
                          const next = new Set(current);
                          if (next.has(document.id)) next.delete(document.id);
                          else next.add(document.id);
                          return next;
                        })
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ink-800">{document.filename}</span>
                      <span className="text-[10px] text-ink-400">
                        {String(document.kind).toLowerCase()}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-2">
        {messages.length === 0 && (
          <p className="pt-6 text-center text-xs text-ink-400">
            {mode === 'PROJECT'
              ? 'Ask about this project — what is open, why a bid is cheaper, what to do next. It reads the real data.'
              : mode === 'EXPERT'
                ? 'Ask about a trade, a detail, or who normally carries what.'
                : 'Ask what the attached documents actually say.'}
            <br />
            Answers cite what they rest on, and never give a price.
          </p>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            className={`rounded-lg px-2.5 py-1.5 text-xs ${
              message.role === 'USER'
                ? 'ml-6 bg-ink-900 text-white'
                : 'mr-2 bg-ink-100 text-ink-800'
            }`}
          >
            <p className="whitespace-pre-wrap">{message.content}</p>
            {message.citations?.length > 0 && (
              <p className="mt-1 text-[10px] opacity-60">
                {message.citations.map((citation) => `${citation.kind} ${citation.ref}`).join(' · ')}
              </p>
            )}
          </div>
        ))}

        {thinking && <p className="text-xs text-ink-400">thinking…</p>}
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div ref={bottom} />
      </div>

      <form onSubmit={ask} className="border-t border-ink-200 p-2">
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) void ask(event);
          }}
          rows={2}
          placeholder={
            mode === 'PROJECT'
              ? 'What is still open on this job?'
              : 'Who normally carries head-of-wall firestopping?'
          }
          className="w-full resize-none rounded border border-ink-300 px-2 py-1.5 text-xs outline-none focus:border-ink-900"
        />
      </form>
    </aside>
  );
}
