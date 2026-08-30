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
  const [attached, setAttached] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'EXPERT' | 'DOCUMENT'>('EXPERT');
  const [question, setQuestion] = useState('');
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

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

      // Optimistic, so the question is on screen while the answer is composed.
      setMessages((current) => [
        ...current,
        { id: `local-${current.length}`, seq: current.length, role: 'USER', content: text, citations: [] },
      ]);

      try {
        let id = threadId;
        if (!id) {
          const thread = await apiPost<Thread>('/consult/threads', {
            projectId,
            title: text.slice(0, 60),
            documentIds: [...attached],
          });
          id = thread.id;
          setThreadId(id);
        }

        const result = await apiPost<{ messages: Message[] }>(`/consult/threads/${id}/ask`, {
          question: text,
          mode,
          documentIds: [...attached],
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
    [question, thinking, threadId, projectId, attached, mode],
  );

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-40 rounded-full bg-slate-900 px-4 py-2.5 text-xs font-medium text-white shadow-lg hover:bg-slate-800"
      >
        Ask an expert
      </button>
    );
  }

  return (
    <aside className="fixed bottom-0 right-0 z-40 flex h-[70vh] w-[26rem] max-w-[95vw] flex-col rounded-tl-lg border-l border-t border-slate-300 bg-white shadow-2xl">
      <header className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-900">Ask an expert</span>
          <div className="flex rounded border border-slate-300 text-[11px]">
            {(['EXPERT', 'DOCUMENT'] as const).map((option) => (
              <button
                key={option}
                onClick={() => setMode(option)}
                className={`px-1.5 py-0.5 ${
                  mode === option ? 'bg-slate-900 text-white' : 'text-slate-500'
                }`}
                title={
                  option === 'EXPERT'
                    ? 'Reasons from division knowledge and gap patterns'
                    : 'Answers only from the attached documents'
                }
              >
                {option === 'EXPERT' ? 'trade' : 'docs'}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-slate-400">
          {messages.length > 0 && (
            <button
              onClick={() => {
                setThreadId(null);
                setMessages([]);
              }}
              className="hover:text-slate-700"
            >
              new
            </button>
          )}
          <button onClick={() => setOpen(false)} className="hover:text-slate-700">
            close
          </button>
        </div>
      </header>

      {documents.length > 0 && (
        <div className="flex flex-wrap gap-1 border-b border-slate-200 px-3 py-1.5">
          {documents.slice(0, 8).map((document) => (
            <button
              key={document.id}
              onClick={() =>
                setAttached((current) => {
                  const next = new Set(current);
                  if (next.has(document.id)) next.delete(document.id);
                  else next.add(document.id);
                  return next;
                })
              }
              className={`max-w-[10rem] truncate rounded px-1.5 py-0.5 text-[10px] ${
                attached.has(document.id)
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-500'
              }`}
              title={document.filename}
            >
              {document.filename}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-2">
        {messages.length === 0 && (
          <p className="pt-6 text-center text-xs text-slate-400">
            Ask about a division, a detail, or what a document actually says.
            <br />
            Answers cite what they rest on, and never give a price.
          </p>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            className={`rounded-lg px-2.5 py-1.5 text-xs ${
              message.role === 'USER'
                ? 'ml-6 bg-slate-900 text-white'
                : 'mr-2 bg-slate-100 text-slate-800'
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

        {thinking && <p className="text-xs text-slate-400">thinking…</p>}
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div ref={bottom} />
      </div>

      <form onSubmit={ask} className="border-t border-slate-200 p-2">
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) void ask(event);
          }}
          rows={2}
          placeholder="Who normally carries head-of-wall firestopping?"
          className="w-full resize-none rounded border border-slate-300 px-2 py-1.5 text-xs outline-none focus:border-slate-900"
        />
      </form>
    </aside>
  );
}
