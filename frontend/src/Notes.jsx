import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import Select from "./Select";

const emptyNote = () => ({ title: "", body: "", session: "", project: "" });

// The preference belongs to this installation, just like the task tab order.
function readNoteOrder() {
  try {
    const value = JSON.parse(localStorage.getItem("noteOrder") || "[]");
    return Array.isArray(value) ? [...new Set(value.filter((id) => Number.isInteger(id) && id > 0))] : [];
  } catch (error) {
    console.error("Não foi possível ler a ordem das notas.", error);
    return [];
  }
}

// One catalogue for existing meeting notes and independent personal notes.
export default function Notes({ notes, sessions, projects, refresh, onError, onOpenSource, targetId, OrganizationMenu }) {
  const [kind, setKind] = useState("personal"), [query, setQuery] = useState("");
  const [project, setProject] = useState("");
  const [order, setOrder] = useState(readNoteOrder), [dropTarget, setDropTarget] = useState(null);
  const draggedNote = useRef(null);
  const [draft, setDraft] = useState(null), [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [highlight, setHighlight] = useState(targetId);
  const target = useRef(null);
  const scrolledTarget = useRef(null);
  useEffect(() => {
    if (!targetId) return;
    setKind("all"); setQuery(""); setProject(""); setHighlight(targetId);
  }, [targetId]);
  // A background refresh must not repeatedly move the reader back to a saved note.
  useEffect(() => {
    if (!highlight || !target.current || scrolledTarget.current === highlight) return;
    scrolledTarget.current = highlight;
    target.current.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [highlight, notes]);
  const ranks = new Map(order.map((id, index) => [id, index]));
  const ordered = [...notes].sort((a, b) => (ranks.get(a.id) ?? order.length) - (ranks.get(b.id) ?? order.length));
  const visible = ordered.filter((note) => {
    const meeting = sessions.find((item) => item.id === note.session);
    return (kind === "all" || (kind === "meeting" ? Boolean(note.session) : !note.session)) &&
      (!project || String(note.project ?? meeting?.project) === project) &&
      `${note.title} ${note.body}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  });
  // Reorder only visible slots: hidden notes keep their relative positions.
  const moveNote = (source, destination) => {
    if (busy || draft || source === destination) return;
    const ids = visible.map((note) => note.id);
    const from = ids.indexOf(source), to = ids.indexOf(destination);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    const visibleIds = new Set(ids);
    let index = 0;
    const next = ordered.map((note) => visibleIds.has(note.id) ? ids[index++] : note.id);
    try { localStorage.setItem("noteOrder", JSON.stringify(next)); setOrder(next); }
    catch (error) { onError(`Não foi possível guardar a ordem das notas: ${error.message}`); }
  };
  // Save through the existing notes API; meeting links remain optional.
  const save = async (event) => {
    event.preventDefault();
    if (busy || !draft?.body.trim()) return;
    setBusy(true);
    try {
      const saved = await api(`/notes/${draft.id ? `${draft.id}/` : ""}`, {
        method: draft.id ? "PATCH" : "POST",
        body: JSON.stringify({ title: draft.title.trim(), body: draft.body.trim(),
          session: draft.session ? Number(draft.session) : null, project: draft.project ? Number(draft.project) : null }),
      });
      setDraft(null); setKind("all"); setQuery(""); setProject(""); setHighlight(saved.id);
      await refresh();
    } catch (error) { onError(error.message); }
    finally { setBusy(false); }
  };
  // Confirm permanent deletion through the existing API, then refresh all note views.
  const deleteNote = async (note) => {
    if (busy || !window.confirm(`Eliminar a nota “${note.title || (note.session ? "Nota de reunião" : "Nota pessoal") }”? Esta ação não pode ser anulada.`)) return;
    setBusy(true); setDeletingId(note.id);
    try {
      await api(`/notes/${note.id}/`, { method: "DELETE" });
      if (draft?.id === note.id) setDraft(null);
      if (highlight === note.id) { setHighlight(null); scrolledTarget.current = null; }
      await refresh();
    } catch (error) { onError(error.message); }
    finally { setBusy(false); setDeletingId(null); }
  };
  // Reuse the fields at the top for creation and inside the selected card for editing.
  const editor = draft && <form className={draft.id ? "note-editor" : "card note-editor"} onSubmit={save}>
      <h3>{draft.id ? "Editar nota" : "Nova nota"}</h3>
      <label>Título <small>(opcional)</small><input maxLength={240} disabled={busy} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })}/></label>
      <label>Conteúdo<textarea required disabled={busy} value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} rows={6}/></label>
      <div className="notes-filters">
        <label>Reunião<Select disabled={busy} value={draft.session || ""} onChange={(event) => setDraft({ ...draft, session: event.target.value })}><option value="">Sem reunião — nota pessoal</option>{sessions.map((item) => <option key={item.id} value={item.id}>{item.title || "Reunião sem título"}</option>)}</Select></label>
        <label>Projeto<Select disabled={busy} value={draft.project || ""} onChange={(event) => setDraft({ ...draft, project: event.target.value })}><option value="">{draft.session ? "Da reunião" : "Sem projeto"}</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>
      </div>
      <div className="form-actions"><button className="primary-action" disabled={busy || !draft.body.trim()}>{busy && deletingId === null ? "A guardar…" : "Guardar nota"}</button><button type="button" className="secondary-action" disabled={busy} onClick={() => setDraft(null)}>Cancelar</button></div>
    </form>;
  return <div className="notes-workspace">
    <div className="notes-toolbar"><nav className="section-tabs" aria-label="Origem das notas">{[["all", "Todas"], ["meeting", "De reuniões"], ["personal", "Pessoais"]].map(([value, label]) => <button type="button" key={value} className={kind === value ? "active" : ""} aria-pressed={kind === value} onClick={() => setKind(value)}>{label}</button>)}</nav><button type="button" className="primary-action" disabled={busy} onClick={() => setDraft(emptyNote())}>Nova nota</button></div>
    <div className="notes-filters">
      <label>Pesquisar<input type="search" value={query} placeholder="Título ou conteúdo…" onChange={(event) => setQuery(event.target.value)}/></label>
      <label>Projeto<Select value={project} onChange={(event) => setProject(event.target.value)}><option value="">Todos</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>
    </div>
    {draft && !draft.id && editor}
    <div className="card-list">{visible.map((note) => {
      const meeting = sessions.find((item) => item.id === note.session);
      return <article className={`card note-card ${dropTarget === note.id ? "note-drop-target" : ""} ${highlight === note.id ? "highlighted-segment" : ""}`} key={note.id} ref={highlight === note.id ? target : null}
        onDragOver={(event) => { if (draggedNote.current == null || busy || draft) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTarget(note.id); }}
        onDrop={(event) => { event.preventDefault(); moveNote(draggedNote.current, note.id); draggedNote.current = null; setDropTarget(null); }}>
        {draft?.id === note.id ? editor : <>
        <div className="projects-heading"><button type="button" className="note-drag-handle" aria-label={`Ordenar nota ${note.title || "sem título"}`} title="Arrastar para ordenar; usar as setas para mover" disabled={busy || Boolean(draft)} draggable={!busy && !draft}
          onDragStart={(event) => { draggedNote.current = note.id; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", String(note.id)); }}
          onDragEnd={() => { draggedNote.current = null; setDropTarget(null); }}
          onKeyDown={(event) => { const offset = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0; if (!offset) return; event.preventDefault(); const destination = visible[visible.findIndex((item) => item.id === note.id) + offset]; if (destination) moveNote(note.id, destination.id); }}>⠿</button><h3>{note.title || (note.session ? "Nota de reunião" : "Nota pessoal")}</h3><div className="form-actions"><button type="button" className="text-button" disabled={busy} onClick={() => setDraft({ ...note, title: note.title || "" })}>Editar</button><button type="button" className="text-button danger" disabled={busy} onClick={() => deleteNote(note)}>{deletingId === note.id ? "A eliminar…" : "Eliminar"}</button></div></div>
        <p className="note-body">{note.body}</p>
        <div className="note-meta"><small>{note.session ? meeting?.title || "Nota de reunião" : "Nota pessoal"} · {new Date(note.updated_at).toLocaleString()}</small>
          {note.session && <button type="button" className="text-button" onClick={() => onOpenSource({ kind: "note", object_id: note.id, meeting_id: note.session })}>Ver na reunião</button>}
          <OrganizationMenu item={note} sessions={sessions} projects={projects} onSave={async (changes) => {
            try { await api(`/notes/${note.id}/`, { method: "PATCH", body: JSON.stringify(changes) }); await refresh(); }
            catch (error) { onError(error.message); }
          }}/>
        </div>
        </>}
      </article>;
    })}</div>
    {!visible.length && <div className="empty">Não há notas para mostrar.</div>}
  </div>;
}
