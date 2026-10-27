import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";

const SOURCE_LABELS = { task: "Tarefa", note: "Nota", session: "Reunião", segment: "Transcrição", summary: "Resumo" };

// Source metadata depends on its kind; a note does not have a task deadline.
function sourceDescription(source) {
  const details = [SOURCE_LABELS[source.kind] || "Fonte"];
  if (source.needs_confirmation) details.push("Por confirmar");
  const date = source.meeting_date || source.created_at;
  if (date) details.push(new Date(date).toLocaleDateString());
  if (source.kind === "task" && Object.hasOwn(source, "due_at")) {
    details.push(source.due_at ? `${source.deadline_ambiguous ? "Prazo por confirmar" : "Prazo"}: ${new Date(source.due_at).toLocaleString()}` : "Sem prazo");
  }
  return details.join(" · ");
}

// Keep general questions independent of the search view and its current filters.
export default function AIQuestionBar({ onOpenSource, panelContainer }) {
  const [question, setQuestion] = useState(""), [sentQuestion, setSentQuestion] = useState("");
  const [answer, setAnswer] = useState(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(null);
  const input = useRef(null), request = useRef(0), controller = useRef(null), id = useId();
  useEffect(() => () => { request.current += 1; controller.current?.abort(); }, []);

  // Discard responses arriving after unmount or a newer request.
  const ask = async (text) => {
    text = text.trim();
    if (!text || busy) return;
    const current = ++request.current;
    controller.current?.abort();
    const pending = new AbortController();
    controller.current = pending;
    setBusy(true); setOpen(true); setSentQuestion(text); setAnswer(null); setError(""); setPreview(null);
    try {
      const result = await api("/assistant/", {
        method: "POST", body: JSON.stringify({ question: text }), signal: pending.signal,
      });
      if (current === request.current) setAnswer(result);
    } catch (nextError) {
      if (current === request.current && !pending.signal.aborted) setError(nextError.message);
    } finally {
      if (current === request.current) setBusy(false);
    }
  };
  // Only the explicit close button hides a response, including while a request is pending.
  const close = () => { input.current?.focus({ preventScroll: true }); setOpen(false); };
  // Daily summaries have no meeting destination; show their saved text in-place.
  const openReference = async (source) => {
    if (source.kind === "summary" && !source.meeting_id) { setPreview(source); return; }
    await onOpenSource(source);
  };
  const panel = open && <section className="ai-task-panel card" id={`${id}-panel`} aria-labelledby={`${id}-title`} aria-busy={busy}>
    <div className="ai-task-panel-heading"><h2 id={`${id}-title`}>Assistente · IA</h2><button type="button" className="text-button" onClick={close}>Fechar resposta</button></div>
    <p className="ai-task-question">{sentQuestion}</p>
    {busy && <p role="status"><span className="spinner" aria-hidden="true"/>A preparar resposta…</p>}
    {error && <div role="alert"><p>{error}</p><button type="button" className="text-button" onClick={() => ask(sentQuestion)}>Tentar novamente</button></div>}
    {answer && <>
      <p className="ai-task-answer">{answer.answer}</p>
      {answer.warning && <p className="ai-task-warning">{answer.warning}</p>}
      {!!answer.sources?.length && <div className="ai-task-sources" aria-label="Fontes da resposta">{answer.sources.map((source) => <button type="button" key={source.id} onClick={() => openReference(source)}>
        <strong>{source.title || source.meeting_title || "Fonte sem título"}</strong><small>{sourceDescription(source)}</small>
      </button>)}</div>}
      {preview && <article className="card"><div className="ai-task-panel-heading"><h3>{preview.title || "Resumo diário"}</h3><button type="button" className="text-button" onClick={() => setPreview(null)}>Fechar fonte</button></div><p className="ai-task-answer">{preview.text}</p></article>}
      {answer.basis && <small className="ai-task-as-of">{answer.basis === "general" ? "Conhecimento geral do modelo · sem pesquisa na Internet." : "Dados guardados na aplicação."}</small>}
      {answer.as_of && <small className="ai-task-as-of">Consultado em {new Date(answer.as_of).toLocaleString()}</small>}
    </>}
  </section>;
  return <>
    <form className="ai-question-bar" role="search" aria-label="Perguntas à IA" onSubmit={(event) => { event.preventDefault(); ask(question); }}>
      <label htmlFor={id} className="sr-only">Perguntar à IA</label>
      <input ref={input} id={id} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Perguntar à IA..." maxLength={2000} autoComplete="off" aria-controls={`${id}-panel`}/>
      <button type="submit" disabled={busy || !question.trim()} aria-controls={`${id}-panel`} aria-expanded={open} aria-label={busy ? "A preparar resposta" : "Enviar pergunta"} title={busy ? "A preparar resposta…" : "Enviar pergunta"}>
        {busy ? <span className="spinner" aria-hidden="true"/> : <svg aria-hidden="true" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 7-7 7 7M12 5v15"/></svg>}
      </button>
    </form>
    {panel && panelContainer.current && createPortal(panel, panelContainer.current)}
  </>;
}
