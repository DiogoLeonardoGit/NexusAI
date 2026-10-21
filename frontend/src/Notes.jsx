import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import Select from "./Select";
import MultiSelect from "./MultiSelect";

const emptyNote = () => ({ title: "", body: "", session: "", project: "", tags: [] });

// One catalogue for existing meeting notes and independent personal notes.
export default function Notes({ notes, sessions, projects, tags, refresh, onError, onOpenSource, targetId, OrganizationMenu }) {
  const [kind, setKind] = useState("personal"), [query, setQuery] = useState("");
  const [project, setProject] = useState(""), [tag, setTag] = useState("");
  const [draft, setDraft] = useState(null), [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [highlight, setHighlight] = useState(targetId);
  const target = useRef(null);
  const scrolledTarget = useRef(null);
  useEffect(() => {
    if (!targetId) return;
    setKind("all"); setQuery(""); setProject(""); setTag(""); setHighlight(targetId);
  }, [targetId]);
  // A background refresh must not repeatedly move the reader back to a saved note.
  useEffect(() => {
    if (!highlight || !target.current || scrolledTarget.current === highlight) return;
    scrolledTarget.current = highlight;
    target.current.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [highlight, notes]);
  const visible = notes.filter((note) => {
    const meeting = sessions.find((item) => item.id === note.session);
    return (kind === "all" || (kind === "meeting" ? Boolean(note.session) : !note.session)) &&
      (!project || String(note.project ?? meeting?.project) === project) &&
      (!tag || note.tags?.includes(Number(tag))) &&
      `${note.title} ${note.body}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  });
  // Save through the existing notes API; meeting links remain optional.
  const save = async (event) => {
    event.preventDefault();
    if (busy || !draft?.body.trim()) return;
    setBusy(true);
    try {
      const saved = await api(`/notes/${draft.id ? `${draft.id}/` : ""}`, {
        method: draft.id ? "PATCH" : "POST",
        body: JSON.stringify({ title: draft.title.trim(), body: draft.body.trim(),
          session: draft.session ? Number(draft.session) : null, project: draft.project ? Number(draft.project) : null, tags: draft.tags }),
      });
      setDraft(null); setKind("all"); setQuery(""); setProject(""); setTag(""); setHighlight(saved.id);
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
        <label>Etiquetas<MultiSelect disabled={busy} options={tags} value={draft.tags} onChange={(value) => setDraft({ ...draft, tags: value })}/></label>
      </div>
      <div className="form-actions"><button className="primary-action" disabled={busy || !draft.body.trim()}>{busy && deletingId === null ? "A guardar…" : "Guardar nota"}</button><button type="button" className="secondary-action" disabled={busy} onClick={() => setDraft(null)}>Cancelar</button></div>
    </form>;
  return <div className="notes-workspace">
    <div className="notes-toolbar"><nav className="section-tabs" aria-label="Origem das notas">{[["all", "Todas"], ["meeting", "De reuniões"], ["personal", "Pessoais"]].map(([value, label]) => <button type="button" key={value} className={kind === value ? "active" : ""} aria-pressed={kind === value} onClick={() => setKind(value)}>{label}</button>)}</nav><button type="button" className="primary-action" disabled={busy} onClick={() => setDraft(emptyNote())}>Nova nota</button></div>
    <div className="notes-filters">
      <label>Pesquisar<input type="search" value={query} placeholder="Título ou conteúdo…" onChange={(event) => setQuery(event.target.value)}/></label>
      <label>Projeto<Select value={project} onChange={(event) => setProject(event.target.value)}><option value="">Todos</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>
      <label>Etiqueta<Select value={tag} onChange={(event) => setTag(event.target.value)}><option value="">Todas</option>{tags.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>
    </div>
    {draft && !draft.id && editor}
    <div className="card-list">{visible.map((note) => {
      const meeting = sessions.find((item) => item.id === note.session);
      return <article className={`card note-card ${highlight === note.id ? "highlighted-segment" : ""}`} key={note.id} ref={highlight === note.id ? target : null}>
        {draft?.id === note.id ? editor : <>
        <div className="projects-heading"><h3>{note.title || (note.session ? "Nota de reunião" : "Nota pessoal")}</h3><div className="form-actions"><button type="button" className="text-button" disabled={busy} onClick={() => setDraft({ ...note, title: note.title || "", tags: note.tags || [] })}>Editar</button><button type="button" className="text-button danger" disabled={busy} onClick={() => deleteNote(note)}>{deletingId === note.id ? "A eliminar…" : "Eliminar"}</button></div></div>
        <p className="note-body">{note.body}</p>
        <div className="note-meta"><small>{note.session ? meeting?.title || "Nota de reunião" : "Nota pessoal"} · {new Date(note.updated_at).toLocaleString()}</small>
          {note.session && <button type="button" className="text-button" onClick={() => onOpenSource({ kind: "note", object_id: note.id, meeting_id: note.session })}>Ver na reunião</button>}
          <OrganizationMenu item={note} sessions={sessions} projects={projects} tags={tags} showTags onSave={async (changes) => {
            try { await api(`/notes/${note.id}/`, { method: "PATCH", body: JSON.stringify(changes) }); await refresh(); }
            catch (error) { onError(error.message); }
          }}/>
        </div>
        <div className="task-labels">{tags.filter((item) => note.tags?.includes(item.id)).map((item) => <span className="label-chip" key={item.id}><i style={{ backgroundColor: item.color }}/>{item.name}</span>)}</div>
        </>}
      </article>;
    })}</div>
    {!visible.length && <div className="empty">Não há notas para mostrar.</div>}
  </div>;
}
