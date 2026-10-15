import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { api, apiText } from "./api";
import Select from "./Select";
import MultiSelect from "./MultiSelect";
import Popup, { useOutsideDismiss } from "./Popup";
import GitLabSettings, { GitLabIcon, LocalToGitLabIcon } from "./GitLabSettings";
import Notes from "./Notes";
import { moveTaskLabels, tasksForLabelView } from "./taskLabels";
import { startActiveListening, startCapture } from "./capture";


const VIEWS = ["Hoje", "Tarefas", "Projetos", "Reuniões", "Notas", "Pesquisa", "Definições", "Logs"];
const REMINDER_OPTIONS = [[0, "Na hora"], [5, "5 minutos antes"], [15, "15 minutos antes"], [30, "30 minutos antes"], [60, "1 hora antes"], [1440, "1 dia antes"]];
const GITLAB_PRIMARY_LABELS = new Set(["To Do", "On Going", "On Testing / Pending Deploy"]);

// GitLab uses working days: a month is four weeks, a week five eight-hour days.
const GITLAB_TIME_UNITS = [["mo", 576000], ["w", 144000], ["d", 28800], ["h", 3600], ["m", 60]];

// Preserve seconds in imported totals while displaying larger GitLab units.
function formatTrackedTime(seconds = 0) {
  let remaining = Math.max(0, Math.floor(Number(seconds) || 0));
  const parts = [];
  for (const [unit, size] of [...GITLAB_TIME_UNITS, ["s", 1]]) {
    const amount = Math.floor(remaining / size);
    if (amount) parts.push(`${amount}${unit}`);
    remaining %= size;
  }
  return parts.join(" ") || "0m";
}

// Consume the entire duration, rejecting stray text and totals below minute precision.
function parseGitLabDuration(value) {
  const input = value.trim();
  if (!input || input.length > 256) return null;
  const units = Object.fromEntries(GITLAB_TIME_UNITS);
  let end = 0, seconds = 0;
  for (const match of input.matchAll(/(\d+(?:[.,]\d+)?)\s*(mo|w|d|h|m)/g)) {
    if (input.slice(end, match.index).trim()) return null;
    seconds += Number(match[1].replace(",", ".")) * units[match[2]];
    end = match.index + match[0].length;
  }
  const rounded = Math.round(seconds / 60) * 60;
  return !input.slice(end).trim() && Number.isSafeInteger(rounded) && rounded >= 60 && rounded <= 2147483647 && Math.abs(seconds - rounded) < 0.000001 ? rounded : null;
}

// Explicit date orders override the default; missing deadlines always stay last.
function compareTasks(left, right, order = "default") {
  if (order === "created-asc" || order === "created-desc") {
    const direction = order === "created-asc" ? 1 : -1;
    return direction * (new Date(left.created_at) - new Date(right.created_at)) || right.id - left.id;
  }
  if (left.due_at && !right.due_at) return -1;
  if (!left.due_at && right.due_at) return 1;
  if (left.due_at && right.due_at) {
    const difference = new Date(left.due_at) - new Date(right.due_at);
    if (difference) return order === "due-desc" ? -difference : difference;
  }
  return new Date(right.created_at) - new Date(left.created_at) || right.id - left.id;
}

function Spinner() { return <span className="spinner" aria-hidden="true" />; }

function AutoSizeTextarea({ value, ...props }) {
  const input = useRef(null);
  // Measure rendered lines so both explicit breaks and wrapped text fit.
  useLayoutEffect(() => {
    const element = input.current;
    const resize = () => {
      element.style.height = "auto";
      const border = element.offsetHeight - element.clientHeight;
      element.style.height = `${element.scrollHeight + border}px`;
    };
    resize();
    let width = element.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = element.getBoundingClientRect().width;
      if (nextWidth !== width) { width = nextWidth; resize(); }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [value]);
  return <textarea {...props} ref={input} rows={1} value={value}/>;
}

function formatTranscriptTime(milliseconds) {
  const seconds = Math.max(0, Math.floor((milliseconds || 0) / 1000));
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

function formatElapsedTime(startedAt) {
  if (!startedAt) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

function localDateValue(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function formatCalendarDate(value) {
  return new Date(`${value}T12:00:00`).toLocaleDateString("pt-PT", { dateStyle: "long" });
}

// Use the user's calendar day, not a UTC date, to classify deadlines.
function deadlineGroup(task, now = new Date()) {
  if (!task.due_at) return "Sem prazo";
  const due = new Date(task.due_at), today = localDateValue(now);
  if (due < now) return "Atrasadas";
  if (localDateValue(due) === today) return "Hoje";
  const limit = new Date(now); limit.setDate(limit.getDate() + 7);
  return localDateValue(due) <= localDateValue(limit) ? "Próximos sete dias" : "Mais tarde";
}

function matchesOrganization(item, project, tag, sessions, meetingProjectOnly = false) {
  const meeting = sessions.find((session) => session.id === item.session);
  const projectId = meetingProjectOnly ? meeting?.project : item.project ?? meeting?.project;
  return (!project || String(projectId) === String(project)) &&
    (!tag || item.tags?.includes(Number(tag)));
}

function OrganizationFields({ item, projects, tags, onSave, showTags = false, sessions, allowProject = true }) {
  const [saving, setSaving] = useState(false);
  const save = async (changes) => {
    if (saving) return;
    setSaving(true);
    try { await onSave(changes); } finally { setSaving(false); }
  };
  return <div className="organization-fields">
    {allowProject && <label>Projeto<Select disabled={saving} value={item.project || ""} onChange={(event) => save({ project: event.target.value ? Number(event.target.value) : null })}>
      <option value="">Sem projeto</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
    </Select></label>}
    {showTags && <div className="organization-label-field"><span>Etiquetas</span><MultiSelect options={tags} value={item.tags || []} disabled={saving} onChange={(value) => save({ tags: value })}/></div>}
    {sessions && <label>Reunião<Select aria-label="Reunião associada" disabled={saving} value={item.session || ""} onChange={(event) => save({ session: event.target.value ? Number(event.target.value) : null })}>
      <option value="">Sem reunião</option>{sessions.map((session) => <option key={session.id} value={session.id}>{session.title || "Reunião sem título"}</option>)}
    </Select></label>}
  </div>;
}

// Assignment controls sit beside actions, keeping the reading flow clear.
function OrganizationMenu(props) {
  const meeting = props.sessions?.find((item) => item.id === props.item.session);
  const project = props.projects.find((item) => item.id === (props.allowProject === false ? meeting?.project : props.item.project));
  const labels = props.showTags ? props.tags.filter((item) => props.item.tags?.includes(item.id)) : [];
  const heading = props.allowProject === false ? "Reunião e etiquetas" : props.showTags ? "Projeto e etiquetas" : "Projeto";
  return <Popup className="organization-menu"><summary aria-label={`Organizar ${heading.toLocaleLowerCase()}`} title={[project?.name, ...labels.map((item) => item.name)].filter(Boolean).join(" · ") || heading}>Organizar</summary>
    <div className="organization-panel"><h4>{heading}</h4><OrganizationFields {...props}/></div>
  </Popup>;
}

// References reveal their evidence and source links on hover, focus or click.
function ReferenceInfo({ children, label = "Referências" }) {
  const [open, setOpen] = useState(false);
  const id = useId(), root = useRef(null);
  useOutsideDismiss(root, open, () => setOpen(false));
  return <span ref={root} className="reference-info" onMouseEnter={() => setOpen(true)} onMouseLeave={(event) => { if (!event.currentTarget.contains(document.activeElement)) setOpen(false); }}
    onFocus={() => setOpen(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } }}>
    <button type="button" className="info-button" aria-label={label} aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(true)}>ⓘ</button>
    {open && <span id={id} className="reference-panel" role="region" aria-label={label}>{children}</span>}
  </span>;
}

function Projects({ projects, tags, sessions, tasks, notes, summaries, refresh, onError, onOpen, onProjectSaved, onTagSaved, taskProps }) {
  const [selected, setSelected] = useState(null), [name, setName] = useState(""), [description, setDescription] = useState(""), [tagName, setTagName] = useState("");
  const [editingProject, setEditingProject] = useState(null), [editingTag, setEditingTag] = useState(null);
  const [busy, setBusy] = useState(""), [formError, setFormError] = useState({}), [success, setSuccess] = useState("");
  const [form, setForm] = useState(null);
  const project = projects.find((item) => item.id === selected);
  // Keep returned records visible even if an unrelated dashboard refresh fails.
  const save = async (kind, body, id = null) => {
    if (busy) return null;
    setBusy(kind); setFormError({}); setSuccess("");
    try {
      const item = await api(`/${kind}/${id ? `${id}/` : ""}`, { method: id ? "PATCH" : "POST", body: JSON.stringify(body) });
      if (kind === "projects") onProjectSaved(item); else onTagSaved(item);
      setSuccess(id ? "Alterações guardadas." : kind === "projects" ? "Projeto criado." : "Etiqueta criada.");
      await refresh();
      return item;
    } catch (error) { setFormError({ [kind]: error.message }); return null; }
    finally { setBusy(""); }
  };
  const projectSessions = sessions.filter((item) => item.project === project?.id);
  const projectTasks = tasks.filter((item) => matchesOrganization(item, project?.id, "", sessions, true));
  const projectNotes = notes.filter((item) => matchesOrganization(item, project?.id, "", sessions));
  // Associated records live inside their meeting; standalone records remain directly navigable.
  const standaloneNotes = projectNotes.filter((note) => !projectSessions.some((meeting) => meeting.id === note.session));
  const projectSubmit = async (event) => {
    event.preventDefault();
    const item = await save("projects", { name: (editingProject ? editingProject.name : name).trim(), description: editingProject ? editingProject.description : description }, editingProject?.id);
    if (item) { setSelected(item.id); setName(""); setDescription(""); setEditingProject(null); setForm(null); }
  };
  const tagSubmit = async (event) => {
    event.preventDefault();
    const item = await save("tags", { name: (editingTag ? editingTag.name : tagName).trim() }, editingTag?.id);
    if (item) { setTagName(""); setEditingTag(null); setForm(null); }
  };
  // Removing a local label also removes its view, never its associated contents.
  const deleteTag = async (tag) => {
    if (busy || tag.is_gitlab || !window.confirm(`Eliminar a etiqueta “${tag.name}”? As associações e a sua vista de tarefas serão removidas. As tarefas, reuniões e notas serão mantidas.`)) return;
    setBusy("delete-tag"); setFormError({}); setSuccess("");
    try {
      await api(`/tags/${tag.id}/`, { method: "DELETE" });
      if (editingTag?.id === tag.id) setEditingTag(null);
      setSuccess("Etiqueta eliminada."); await refresh();
    } catch (error) { setFormError({ tags: error.message }); }
    finally { setBusy(""); }
  };
  return <div className="projects-workspace">
    {project && <button type="button" className="back" onClick={() => { setSelected(null); setForm(null); }}>← Todos os projetos</button>}
    <div className="projects-heading">{!project && <div><h2>Os teus projetos</h2><p>Reuniões, notas e tarefas organizadas por projeto.</p></div>}<div className="form-actions"><button type="button" className="primary-action" disabled={Boolean(busy)} onClick={() => { setEditingProject(null); setForm(form === "project" ? null : "project"); }}>Novo projeto</button><button type="button" className="secondary-action" disabled={Boolean(busy)} onClick={() => { setEditingTag(null); setForm(form === "tags" ? null : "tags"); }}>Gerir etiquetas</button></div></div>
    {success && <p className="project-success" role="status">{success}</p>}
    {form && <div className="organization-forms">
      {form === "project" && <form className="organization-form" onSubmit={projectSubmit}>
        <h3>{editingProject ? "Editar projeto" : "Novo projeto"}</h3>
        <label>Nome<input required maxLength={120} disabled={Boolean(busy)} value={editingProject ? editingProject.name : name} onChange={(event) => editingProject ? setEditingProject({ ...editingProject, name: event.target.value }) : setName(event.target.value)} placeholder="Ex.: Cliente, produto ou iniciativa"/></label>
        <label>Descrição <small>(opcional)</small><textarea disabled={Boolean(busy)} value={editingProject ? editingProject.description : description} onChange={(event) => editingProject ? setEditingProject({ ...editingProject, description: event.target.value }) : setDescription(event.target.value)} placeholder="O que está a ser desenvolvido?" rows={2}/></label>
        {formError.projects && <p className="field-error" role="alert">{formError.projects}</p>}
        <div className="form-actions"><button className="primary-action" type="submit" disabled={Boolean(busy) || !(editingProject ? editingProject.name : name).trim()}>{busy === "projects" && <Spinner/>}{editingProject ? "Guardar projeto" : "Criar projeto"}</button><button className="secondary-action" type="button" onClick={() => { setEditingProject(null); setForm(null); }}>Cancelar</button></div>
      </form>}
      {form === "tags" && <div className="organization-form">
        <form onSubmit={tagSubmit}><h3>{editingTag ? "Editar etiqueta" : "Etiquetas"}</h3><p className="muted">Usa etiquetas para ligar assuntos entre projetos.</p>
          <label>Nome<input required maxLength={80} disabled={Boolean(busy)} value={editingTag ? editingTag.name : tagName} onChange={(event) => editingTag ? setEditingTag({ ...editingTag, name: event.target.value }) : setTagName(event.target.value)} placeholder="Ex.: Planeamento"/></label>
          {formError.tags && <p className="field-error" role="alert">{formError.tags}</p>}
          <div className="form-actions"><button className="primary-action" type="submit" disabled={Boolean(busy) || !(editingTag ? editingTag.name : tagName).trim()}>{busy === "tags" && <Spinner/>}{editingTag ? "Guardar etiqueta" : "Criar etiqueta"}</button><button className="secondary-action" type="button" onClick={() => { setEditingTag(null); setForm(null); }}>Cancelar</button></div>
        </form>
        <div className="tag-management">{tags.map((tag) => <div className="tag-management-item" key={tag.id}><button type="button" className="tag-pill" disabled={Boolean(busy)} onClick={() => { setEditingTag({ ...tag }); setFormError({}); }}>{tag.name}<span aria-hidden="true">✎</span><span className="sr-only">Editar etiqueta</span></button><button type="button" className="text-button danger" aria-label={`Eliminar etiqueta ${tag.name}`} disabled={Boolean(busy) || tag.is_gitlab} title={tag.is_gitlab ? "Etiqueta gerida no GitLab" : "Eliminar etiqueta local"} onClick={() => deleteTag(tag)}>Eliminar</button></div>)}</div>
      </div>}
    </div>}
    {!project && (projects.length ? <div className="project-grid">{projects.map((item) => <button type="button" className={`project-tile ${selected === item.id ? "selected" : ""}`} aria-pressed={selected === item.id} key={item.id} onClick={() => setSelected(item.id)}><strong>{item.name}</strong><p>{item.description || "Sem descrição"}</p><small>{sessions.filter((session) => session.project === item.id).length} reuniões · {tasks.filter((task) => matchesOrganization(task, item.id, "", sessions, true)).length} tarefas</small></button>)}</div> : <div className="project-empty"><strong>A tua próxima reunião pode ter um lugar.</strong><p>Usa “Novo projeto” para começar e associa-lhe reuniões.</p></div>)}
    {project && <section className="project-detail">
      <div className="projects-heading"><div><h2>{project.name}</h2><p>{project.description}</p><small>{projectSessions.length} reuniões · {projectTasks.length} tarefas · {projectNotes.length} notas</small></div><button type="button" className="secondary-action" disabled={Boolean(busy)} onClick={() => { setEditingProject({ ...project }); setFormError({}); setForm("project"); }}>Editar projeto</button></div>
      <h3>Reuniões e decisões</h3>
      <div className="card-list">{projectSessions.length ? projectSessions.map((meeting) => <details className="project-meeting-group" key={meeting.id}>
        <summary className="card project-meeting"><strong>{meeting.title || "Reunião sem título"}</strong><small>{new Date(meeting.started_at).toLocaleDateString()}</small><button type="button" className="text-button project-open-meeting" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onOpen({ kind: "session", object_id: meeting.id, meeting_id: meeting.id }); }}>Abrir reunião →</button></summary>
        <div className="project-meeting-content">
          {summaries.filter((summary) => summary.kind === "meeting" && summary.session === meeting.id).map((summary) => <div key={summary.id} role="link" tabIndex={0} className="project-summary-link"
            onClick={() => onOpen({ kind: "summary", object_id: summary.id, meeting_id: meeting.id })}
            onKeyDown={(event) => { if (event.key === "Enter") onOpen({ kind: "summary", object_id: summary.id, meeting_id: meeting.id }); }}>
            <SummaryCard summary={summary} title="Resumo"/></div>)}
          <h4>Notas</h4><div className="card-list">{notes.filter((note) => note.session === meeting.id).map((note) => <button type="button" className="card project-content-link" key={note.id} onClick={() => onOpen({ kind: "note", object_id: note.id, meeting_id: meeting.id })}><strong>{note.title || "Nota pessoal"}</strong><p>{note.body}</p></button>)}</div>
          <h4>Tarefas</h4><TaskList {...taskProps} tasks={projectTasks.filter((task) => task.session === meeting.id)} defaultSession={meeting.id} initialFilter="all"/>
        </div>
      </details>) : <p className="empty">Associa uma reunião a este projeto para consultar as suas decisões aqui.</p>}</div>
      {standaloneNotes.length > 0 && <><h3>Notas sem reunião neste projeto</h3><div className="card-list">{standaloneNotes.map((note) => <button type="button" className="card project-content-link" key={note.id} onClick={() => onOpen({ kind: "note", object_id: note.id, meeting_id: note.session })}><strong>{note.title || "Nota pessoal"}</strong><p>{note.body}</p></button>)}</div></>}
    </section>}
  </div>;
}

function TaskCreateButton({ open, onClick, formId = "new-task-form" }) {
  return <button type="button" className="add-task-button" aria-label="Adicionar tarefa" title={open ? "Fechar formulário" : "Adicionar tarefa"} aria-expanded={open} aria-controls={formId} onClick={onClick}><span aria-hidden="true">+</span></button>;
}

// Recover a usable preference if a previous local order is missing or malformed.
function readTaskSectionOrder() {
  try {
    const value = JSON.parse(localStorage.getItem("taskSectionOrder") || "[]");
    return Array.isArray(value) ? [...new Set(value.filter((id) => Number.isInteger(id) && id > 0))] : [];
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

export function TaskList({ tasks, sections = [], showSections, refresh, onError, today, projects = [], tags = [], onOpenSource, targetId, targetKey, defaultSession = null, sessions = [], gitlabStatus, createOpen, onCreateOpenChange, initialFilter = "todo", compactCreate = false, settingsFilters = null, activeFilterCount = 0 }) {
  const localFormId = useId();
  const formId = showSections ? "new-task-form" : `new-task-${localFormId}`;
  const [title, setTitle] = useState(""), [description, setDescription] = useState("");
  const [newSession, setNewSession] = useState(defaultSession || "");
  const [sectionName, setSectionName] = useState(""), [columnTag, setColumnTag] = useState("");
  const [localCreateOpen, setLocalCreateOpen] = useState(false), [layout, setLayout] = useState(() => localStorage.getItem("taskLayout") || "list");
  // The Tarefas page controls creation from its global filter row; other usages stay local.
  const showCreate = createOpen ?? localCreateOpen;
  const setShowCreate = onCreateOpenChange ?? setLocalCreateOpen;
  const [taskSearch, setTaskSearch] = useState(""), [taskOrder, setTaskOrder] = useState("default");
  const [unassignedCollapsed, setUnassignedCollapsed] = useState(false), [dropTarget, setDropTarget] = useState(null);
  const [sectionOrder, setSectionOrder] = useState(readTaskSectionOrder);
  const draggedTask = useRef(null);
  const draggedSection = useRef(null);
  const orderedSections = [...sectionOrder.map((id) => sections.find((section) => section.id === id)).filter(Boolean), ...sections.filter((section) => !sectionOrder.includes(section.id))];
  const [filter, setFilter] = useState(initialFilter), [editingTask, setEditingTask] = useState(null);
  const [dueAt, setDueAt] = useState(""), [minutesBefore, setMinutesBefore] = useState(15), [busy, setBusy] = useState(null);
  const [selecting, setSelecting] = useState(false), [selectedIds, setSelectedIds] = useState([]), [bulkLabels, setBulkLabels] = useState([]);
  const [actionResult, setActionResult] = useState("");
  const [timeDuration, setTimeDuration] = useState("");
  const [estimateDuration, setEstimateDuration] = useState("");
  const draftEstimateSeconds = editingTask ? (estimateDuration.trim() === editingTask.original.estimateDuration ? editingTask.original.estimateSeconds : parseGitLabDuration(estimateDuration)) : 0;
  const run = async (key, operation) => {
    if (busy) return false;
    setBusy(key);
    try { await operation(); await refresh(); return true; }
    catch (error) { onError(error.message); return false; }
    finally { setBusy(null); }
  };
  const createTask = async (event) => {
    event.preventDefault();
    if (!title.trim()) return;
    const saved = await run("new", () => api("/tasks/", { method: "POST", body: JSON.stringify({ title: title.trim(), description: description.trim(), owner: "self", status: "todo", session: newSession ? Number(newSession) : null }) }));
    if (saved) { setTitle(""); setDescription(""); setShowCreate(false); }
  };
  // Persist section changes through the same API/refresh flow as task edits.
  const createSection = async (event) => {
    event.preventDefault();
    if ((!sectionName.trim() && !columnTag) || busy) return;
    const saved = await run("new-section", () => api("/task-sections/", {
      method: "POST", body: JSON.stringify(columnTag ? { tag: Number(columnTag) } : { name: sectionName.trim() }),
    }));
    if (saved) { setSectionName(""); setColumnTag(""); }
  };
  const toggleSection = (section) => {
    if (section.id === "done") return;
    if (section.id === null) { setUnassignedCollapsed((value) => !value); return; }
    return run(`section-${section.id}`, () => api(`/task-sections/${section.id}/`, {
      method: "PATCH", body: JSON.stringify({ collapsed: !section.collapsed }),
    }));
  };
  // Reordering headings changes only presentation, never task label memberships.
  const reorderSections = (event, destination) => {
    event.preventDefault(); event.stopPropagation(); setDropTarget(null);
    const source = draggedSection.current; draggedSection.current = null;
    if (busy || destination.tag == null || source === destination.id) return;
    const next = orderedSections.map((section) => section.id);
    const from = next.indexOf(source), to = next.indexOf(destination.id);
    if (from < 0 || to < 0) return;
    next.splice(to, 0, next.splice(from, 1)[0]);
    try { localStorage.setItem("taskSectionOrder", JSON.stringify(next)); setSectionOrder(next); }
    catch (error) { onError(`Não foi possível guardar a ordem dos separadores: ${error.message}`); }
  };
  // Dropping on the whole section also supports empty and collapsed groups.
  const moveTask = async (event, destination) => {
    event.preventDefault(); event.stopPropagation(); setDropTarget(null);
    const dragged = draggedTask.current; draggedTask.current = null;
    const task = tasks.find((item) => item.id === dragged?.id);
    if (!task || busy) return;
    if (destination.id === "done") {
      await run(`move-${task.id}`, () => api(`/tasks/${task.id}/complete/`, { method: "POST" })); return;
    }
    const changes = { tags: moveTaskLabels(task, dragged.tag, destination.tag) };
    if (dragged.done) changes.status = "todo";
    await run(`move-${task.id}`, () => api(`/tasks/${task.id}/`, { method: "PATCH", body: JSON.stringify(changes) }));
  };
  // Snapshot the editable values so background refreshes do not turn untouched fields into edits.
  const beginTaskEdit = (task) => {
    let initialDueAt = "";
    if (task.due_at) {
      const date = new Date(task.due_at);
      date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
      initialDueAt = date.toISOString().slice(0, 16);
    }
    const initialEstimate = task.estimate_seconds ? formatTrackedTime(task.estimate_seconds) : "";
    const initialMinutes = task.reminder_minutes_before ?? 15;
    setEditingTask({ id: task.id, title: task.title, description: task.description || "", owner: task.owner, owner_name: task.owner_name || "",
      tags: [...(task.tags || [])], session: task.session ?? null,
      original: { dueAt: initialDueAt, minutesBefore: initialMinutes, estimateDuration: initialEstimate, estimateSeconds: task.estimate_seconds || 0, tags: [...(task.tags || [])], session: task.session ?? null } });
    setDueAt(initialDueAt); setMinutesBefore(initialMinutes);
    setEstimateDuration(initialEstimate); setTimeDuration("");
  };
  // Commit every draft field together; the API validates and saves the edit atomically.
  const saveTask = async () => {
    if (busy || !editingTask?.title.trim()) return;
    const original = editingTask.original;
    const changes = { title: editingTask.title.trim(), description: editingTask.description.trim(), owner: editingTask.owner,
      owner_name: editingTask.owner === "other" ? editingTask.owner_name.trim() : "" };
    let estimate = original.estimateSeconds;
    if (estimateDuration.trim() !== original.estimateDuration) {
      estimate = parseGitLabDuration(estimateDuration);
      if (estimate === null) { onError("Indica uma estimativa válida, como 1w ou 1h 30m, em minutos inteiros positivos."); return; }
      changes.estimate_seconds = estimate;
    }
    if (timeDuration.trim()) {
      const duration = parseGitLabDuration(timeDuration);
      if (duration === null) { onError("Indica um tempo válido, como 1h 30m, em minutos inteiros positivos."); return; }
      if (!estimate) { onError("Define uma estimativa antes de registar tempo."); return; }
      changes.time_entry = { duration_seconds: duration };
    }
    if (dueAt !== original.dueAt || Number(minutesBefore) !== original.minutesBefore) {
      const date = dueAt ? new Date(dueAt) : null;
      if (date && Number.isNaN(date.getTime())) { onError("Indica uma data limite válida."); return; }
      if (!date && !original.dueAt && Number(minutesBefore) !== original.minutesBefore) { onError("Define uma data limite para o lembrete."); return; }
      changes.due_at = date ? date.toISOString() : null;
      changes.reminder_offset_minutes = Number(minutesBefore);
    }
    if (editingTask.session !== original.session) changes.session = editingTask.session;
    if ([...editingTask.tags].sort((a, b) => a - b).join(",") !== [...original.tags].sort((a, b) => a - b).join(",")) changes.tags = editingTask.tags;
    const saved = await run(`edit-${editingTask.id}`, async () => {
      await api(`/tasks/${editingTask.id}/`, { method: "PATCH", body: JSON.stringify(changes) });
      // Once acknowledged, a refresh error must not append this time entry again.
      setTimeDuration("");
    });
    if (saved) setEditingTask(null);
  };
  const deleteTask = async (task) => {
    if (!window.confirm(`${task.gitlab ? "Ocultar nesta app" : "Eliminar"} a tarefa “${task.title}”?`)) return;
    await run(`delete-${task.id}`, () => api(task.gitlab ? `/tasks/${task.id}/hide/` : `/tasks/${task.id}/`, { method: task.gitlab ? "POST" : "DELETE" }));
  };
  // Search narrows the existing status/owner view before sorting.
  const searchTerm = taskSearch.trim().toLocaleLowerCase("pt-PT");
  const visible = tasks.filter((task) => {
    if (searchTerm && !`${task.title}\n${task.description || ""}`.toLocaleLowerCase("pt-PT").includes(searchTerm)) return false;
    if (filter === "all") return true;
    if (filter === "done") return task.status === "done";
    if (filter === "mine") return task.owner === "self" && !["done", "cancelled"].includes(task.status);
    if (filter === "others") return task.owner === "other" && !["done", "cancelled"].includes(task.status);
    return !["done", "cancelled"].includes(task.status);
  }).sort((left, right) => compareTasks(left, right, taskOrder));
  // IDs are unique even when a task appears in several label views. Hidden
  // selections never participate after a filter change or a background refresh.
  const selectedTasks = visible.filter((task) => selectedIds.includes(task.id));
  const selectedTaskIds = selectedTasks.map((task) => task.id);
  const compatibleLabels = tags.filter((tag) => selectedTasks.every((task) => !task.gitlab || task.gitlab.available_tag_ids.includes(tag.id) || task.tags?.includes(tag.id)));
  const applicableLabels = bulkLabels.filter((id) => compatibleLabels.some((tag) => tag.id === id));
  const selectableKey = visible.map((task) => task.id).sort((a, b) => a - b).join(",");
  useEffect(() => {
    const allowed = new Set(selectableKey ? selectableKey.split(",").map(Number) : []);
    setSelectedIds((current) => current.filter((id) => allowed.has(id)));
  }, [selectableKey]);
  const endSelection = () => {
    setSelecting(false); setSelectedIds([]); setBulkLabels([]); setActionResult("");
  };
  // One backend transaction applies the batch; the sync worker delivers linked changes.
  const applyBulk = async (action) => {
    if (busy || !selectedTaskIds.length || (action === "add_labels" && !applicableLabels.length)) return;
    const openCount = selectedTasks.filter((task) => task.status !== "done").length;
    if (action === "close" && (!openCount || !window.confirm(`Fechar ${openCount} tarefa(s) selecionada(s)? Os lembretes serão cancelados e as labels de progresso serão removidas. As alterações GitLab serão sincronizadas automaticamente quando a escrita estiver ativa.`))) return;
    setActionResult("");
    const saved = await run("bulk", async () => {
      const response = await api("/tasks/bulk/", { method: "POST", body: JSON.stringify({
        task_ids: selectedTaskIds, action, ...(action === "add_labels" ? { tag_ids: applicableLabels } : {}),
      }) });
      setActionResult(`${response.updated} tarefa(s) atualizadas${response.skipped ? ` · ${response.skipped} já concluídas` : ""}.`);
    });
    if (saved) { setSelectedIds([]); setBulkLabels([]); }
  };
  // Frontend preflight explains disabled publishing; the API revalidates live labels.
  const publishDisabledReason = (task) => {
    if (task.gitlab_export) return "Envio sem confirmação. Verifica o GitLab; a criação não será repetida.";
    if (editingTask?.id === task.id) return "Guarda a edição antes de enviar o ticket.";
    if (task.status !== "todo" || task.owner !== "self") return "Só podes enviar tarefas abertas com responsável Eu.";
    if (!gitlabStatus?.enabled || gitlabStatus.read_only || !gitlabStatus.has_token) return "Ativa a sincronização e a escrita e configura o token GitLab.";
    const assigned = tags.filter((tag) => task.tags?.includes(tag.id));
    const invalid = (task.tags || []).filter((id) => !gitlabStatus.available_tag_ids?.includes(id));
    if (invalid.length) return `Estas labels não existem no GitLab: ${invalid.map((id) => tags.find((tag) => tag.id === id)?.name || `#${id}`).join(", ")}`;
    if (!assigned.some((tag) => GITLAB_PRIMARY_LABELS.has(tag.name))) return "Escolhe pelo menos uma label principal: To Do, On Going ou On Testing / Pending Deploy.";
    if (assigned.some((tag) => tag.name.includes(","))) return "A API GitLab não permite enviar labels com vírgulas.";
    return "";
  };
  const publishLocalTask = async (task) => {
    if (busy || publishDisabledReason(task)) return;
    setActionResult("");
    await run(`publish-${task.id}`, async () => {
      const saved = await api(`/tasks/${task.id}/publish/`, { method: "POST" });
      setActionResult(`Ticket #${saved.gitlab.issue_iid} criado no GitLab.`);
    });
  };
  // Targets override filters and folded groups so notification navigation is visible.
  useEffect(() => { if (targetId) { setFilter("all"); setTaskSearch(""); } }, [targetId, targetKey]);
  useEffect(() => {
    if (!targetId) return;
    const frame = requestAnimationFrame(() => document.querySelector(`[data-task-id="${targetId}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
    return () => cancelAnimationFrame(frame);
  }, [targetId, targetKey, tasks, filter, taskSearch]);
  const renderTask = (task, column = null) => {
        const overdue = task.status !== "done" && task.due_at && new Date(task.due_at).getTime() < Date.now();
        const reminderFired = task.status !== "done" && task.reminder_status === "notified";
        const alertClass = overdue ? "overdue" : reminderFired ? "reminder-fired" : "";
        const isEditing = editingTask?.id === task.id;
        // Board cards keep only the title; the whole card retains the existing
        // column drag behaviour and bulk selection is shown only when enabled.
        if (showSections && !today && layout === "board") {
          return <article id={`task-${task.id}-column-${column?.id ?? "unassigned"}`} data-task-id={task.id}
            className={`card task task-board-card ${targetId === task.id ? "highlighted-segment" : ""}`} key={task.id}
            draggable={!busy && !isEditing}
            onDragStart={(event) => {
              if (busy || isEditing) { event.preventDefault(); return; }
              draggedTask.current = { id: task.id, tag: column?.tag ?? null, done: column?.id === "done" };
              event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", String(task.id));
            }}
            onDragEnd={() => { draggedTask.current = null; setDropTarget(null); }}>
            {selecting && <input type="checkbox" className="task-selection" aria-label={`Selecionar tarefa ${task.title}`}
              checked={selectedTaskIds.includes(task.id)} disabled={Boolean(busy)}
              onDragStart={(event) => { event.preventDefault(); event.stopPropagation(); }}
              onChange={(event) => { const checked = event.target.checked; setSelectedIds((current) => checked ? [...new Set([...current, task.id])] : current.filter((id) => id !== task.id)); }}/>
            }
            <h3>{task.title}</h3>
          </article>;
        }
        return <article id={column ? `task-${task.id}-column-${column.id ?? "unassigned"}` : `task-${task.id}`} data-task-id={task.id} className={`card task ${alertClass} ${targetId === task.id ? "highlighted-segment" : ""}`} key={task.id}>
        {selecting && <input type="checkbox" className="task-selection" aria-label={`Selecionar tarefa ${task.title}`} checked={selectedTaskIds.includes(task.id)} disabled={Boolean(busy)} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...new Set([...current, task.id])] : current.filter((id) => id !== task.id))}/>}
        {showSections && <button type="button" className="task-drag-handle" aria-label={`Arrastar tarefa ${task.title}`} title="Arrastar para outra vista de etiqueta" disabled={Boolean(busy) || isEditing} draggable={!busy && !isEditing}
          onDragStart={(event) => { draggedTask.current = { id: task.id, tag: column?.tag ?? null, done: column?.id === "done" }; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", String(task.id)); }}
          onDragEnd={() => { draggedTask.current = null; setDropTarget(null); }}>⠿</button>}
        {(overdue || reminderFired) && <span className="task-alert" title={overdue ? "Prazo ultrapassado" : "Lembrete emitido"}>!</span>}
        <button className={`check ${task.status === "done" ? "done" : ""}`} title={task.status === "done" ? "Reabrir tarefa" : "Concluir tarefa"} disabled={busy === `status-${task.id}`} onClick={() => run(`status-${task.id}`, () => api(`/tasks/${task.id}/${task.status === "done" ? "reopen" : "complete"}/`, { method: "POST" }))}>✓</button>
        <div className="task-body">
          <div className="task-card-header">

            {isEditing ? <input className="task-title-input" disabled={Boolean(busy)} value={editingTask.title} onChange={(event) => setEditingTask({ ...editingTask, title: event.target.value })}/> : <h3>{task.title}</h3>}
            <div className="item-actions">{task.gitlab && <button type="button" className="gitlab-origin" title="Abrir tarefa no GitLab" onClick={() => {
              if (window.notetaker?.openGitLab) window.notetaker.openGitLab(task.gitlab.web_url).catch((error) => onError(error.message));
              else window.open(task.gitlab.web_url, "_blank", "noopener,noreferrer");
            }}><GitLabIcon/></button>}{!task.gitlab && <button type="button" className="gitlab-publish" aria-label="Enviar ticket para o GitLab"
              title={publishDisabledReason(task) || "Enviar ticket para o GitLab"} disabled={Boolean(busy) || Boolean(publishDisabledReason(task))}
              onClick={() => publishLocalTask(task)}>{busy === `publish-${task.id}` ? <Spinner/> : <LocalToGitLabIcon/>}</button>} {isEditing ? <><button className="text-button" onClick={saveTask} disabled={!editingTask.title.trim() || Boolean(busy)}>{busy === `edit-${task.id}` && <Spinner/>}Concluir</button><button className="text-button secondary-text" disabled={Boolean(busy)} onClick={() => setEditingTask(null)}>Cancelar</button></> : <><button className="text-button" disabled={Boolean(busy)} onClick={() => beginTaskEdit(task)}>Editar</button><button className="text-button danger" onClick={() => deleteTask(task)} disabled={busy === `delete-${task.id}`}>{busy === `delete-${task.id}` && <Spinner/>}{task.gitlab ? "Ocultar nesta app" : "Eliminar"}</button></>}</div>
          </div>
          {isEditing ? <AutoSizeTextarea className="task-description-input" disabled={Boolean(busy)} value={editingTask.description} onChange={(event) => setEditingTask({ ...editingTask, description: event.target.value })} placeholder="Descrição (opcional)"/> : task.description && <p className="task-description">{task.description}</p>}

          
          <div className="task-labels">{tags.filter((tag) => task.tags?.includes(tag.id)).map((tag) => <span className="label-chip" key={tag.id}><i style={{ backgroundColor: tag.color || "#6699cc" }}/>{tag.name}</span>)}</div>
          {task.gitlab?.pending && <small className="sync-pending">Alterações locais pendentes de envio</small>}
          {task.gitlab && Object.keys(task.gitlab.conflicts).length > 0 && <div className="sync-conflict" role="alert"><strong>Conflito com o GitLab</strong><p>{Object.keys(task.gitlab.conflicts).join(", ")}</p>
            {Object.entries(task.gitlab.conflicts).map(([field, values]) => <div className="conflict-values" key={field}><strong>{field === "title" ? "Título" : field === "description" ? "Descrição" : field === "estimate_seconds" ? "Estimativa (segundos)" : "Estado"}</strong><p>Na app: {String(values.local)}</p><p>No GitLab: {String(values.remote)}</p></div>)}
            <button disabled={Boolean(busy)} onClick={() => run(`resolve-${task.id}`, () => api(`/tasks/${task.id}/resolve/`, { method: "POST", body: JSON.stringify({ choice: "local" }) }))}>Manter alterações locais</button>
            <button disabled={Boolean(busy)} onClick={() => run(`resolve-${task.id}`, () => api(`/tasks/${task.id}/resolve/`, { method: "POST", body: JSON.stringify({ choice: "remote" }) }))}>Usar versão GitLab</button></div>}
          <div className={`task-meta ${isEditing ? "editing" : ""}`}>
            <span className="task-time-total">Estimativa: {task.estimate_seconds ? formatTrackedTime(task.estimate_seconds) : "Por definir"}</span>
            <span className="task-time-total">Tempo: {formatTrackedTime(task.time_tracking?.total_seconds)}</span>
            {task.gitlab && task.time_tracking?.pending_seconds > 0 && <small className="task-time-pending">{formatTrackedTime(task.time_tracking.pending_seconds)} pendentes de envio</small>}
            {task.time_tracking?.uncertain_seconds > 0 && <small className="task-time-uncertain" role="alert">Envio de {formatTrackedTime(task.time_tracking.uncertain_seconds)} por confirmar. Verifica o GitLab.</small>}
          </div>
          <div className={`task-meta task-details ${isEditing ? "editing" : ""}`}>
            {isEditing ? <><Select aria-label="Responsável da tarefa" disabled={Boolean(busy) || Boolean(task.gitlab)} value={editingTask.owner} onChange={(event) => setEditingTask({ ...editingTask, owner: event.target.value })}><option value="self">Eu</option><option value="other">Outro interveniente</option><option value="unknown">Por definir</option></Select>{editingTask.owner === "other" && <input value={editingTask.owner_name} onChange={(event) => setEditingTask({ ...editingTask, owner_name: event.target.value })} placeholder="Nome do responsável"/>}</> : <span>{task.owner === "self" ? "Eu" : task.owner_name || "Outro interveniente"}</span>}
            {!isEditing && <span>· Criada a {new Date(task.created_at).toLocaleString()} {task.creation_source === "gitlab" ? "no GitLab" : task.creation_source === "system" ? "pelo Sistema" : "por ti"}</span>}
            {task.due_at && <span>· Limite: {new Date(task.due_at).toLocaleString()}</span>}
            {task.reminder_at && <span>· Lembrete: {new Date(task.reminder_at).toLocaleString()}</span>}
            {task.due_is_ambiguous && <span className="warning">Data por confirmar</span>}
          </div>
            {(task.evidence || task.source_segment || task.session) && <ReferenceInfo>{task.evidence && <span className="reference-text">{task.evidence}</span>}{(task.source_segment || task.session) && <button type="button" className="text-button" onClick={() => onOpenSource?.({ kind: "segment", meeting_id: task.source_meeting_id || task.session, segment_id: task.source_segment })}>Ver na reunião{task.source_start_ms != null ? ` · ${formatTranscriptTime(task.source_start_ms)}` : ""}</button>}</ReferenceInfo>}
          {isEditing && <fieldset className="task-edit-fields" disabled={Boolean(busy) || Boolean(task.gitlab && (!task.gitlab.active || task.gitlab.hidden))}>
            <OrganizationFields item={editingTask} allowProject={false} showTags sessions={sessions} projects={projects}
              tags={task.gitlab ? tags.filter((tag) => task.gitlab.available_tag_ids.includes(tag.id) || task.tags?.includes(tag.id)) : tags}
              onSave={(changes) => setEditingTask((current) => ({ ...current, ...changes }))}/>
            <div className="schedule-editor" role="group" aria-label="Data limite e lembrete">
              <label>Data limite<input type="datetime-local" value={dueAt} disabled={Boolean(busy)} onChange={(event) => setDueAt(event.target.value)}/></label>
              <label>Lembrete<Select value={minutesBefore} disabled={Boolean(busy)} onChange={(event) => setMinutesBefore(event.target.value)}>{REMINDER_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</Select></label>
            </div>
            <div className="task-time-fields">
              <div className="task-time-editor" role="group" aria-label="Estimativa">
                <label>Estimativa<input type="text" aria-label="Duração estimada" maxLength={256} value={estimateDuration} disabled={Boolean(busy)} onChange={(event) => setEstimateDuration(event.target.value)} placeholder="Ex.: 1w ou 1h 30m"/></label>
              </div>
              <div className="task-time-editor" role="group" aria-label="Registar tempo">
                <label>Registar tempo<input type="text" aria-label="Duração a registar" maxLength={256} value={timeDuration} disabled={Boolean(busy) || !draftEstimateSeconds} onChange={(event) => setTimeDuration(event.target.value)} placeholder="Ex.: 1h 30m"/></label>
                {!draftEstimateSeconds && <small>Define uma estimativa antes de registar tempo.</small>}
              </div>
            </div>
          </fieldset>}
        </div>
      </article>;
  };
  const groups = [{ id: null, tag: null, name: "Sem etiqueta de vista", collapsed: unassignedCollapsed }, ...orderedSections, ...(layout === "board" ? [{ id: "done", tag: null, name: "Concluídas", collapsed: false }] : [])];
  // Keep bulk actions available while task checkboxes are used outside the panel.
  const taskSelectionControl = !today && <details className={`task-bulk-popup ${selecting ? "is-selecting" : ""}`} open={selecting}
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); endSelection(); } }}>
        <summary aria-expanded={selecting} aria-disabled={Boolean(busy) || Boolean(editingTask)} onClick={(event) => {
          event.preventDefault();
          if (busy || editingTask) return;
          if (selecting) endSelection();
          else setSelecting(true);
        }}>{selecting ? "Terminar seleção" : "Selecionar tarefas"}{selecting && <span className="bulk-selection-count">{selectedTasks.length}</span>}</summary>
        <div className="task-bulk-controls"><strong>{selectedTasks.length} selecionadas</strong><button type="button" className="text-button" disabled={Boolean(busy) || !visible.length} onClick={() => setSelectedIds(visible.map((task) => task.id))}>Selecionar todas as filtradas</button><button type="button" className="text-button" disabled={Boolean(busy) || !selectedTasks.length} onClick={() => { setSelectedIds([]); setBulkLabels([]); }}>Limpar seleção</button>
        <div className="bulk-label-actions"><div className="bulk-label-picker">{!selectedTasks.length && <small>Seleciona pelo menos uma tarefa</small>}<MultiSelect label="Etiquetas para adicionar às tarefas selecionadas" options={compatibleLabels} value={applicableLabels} disabled={Boolean(busy)} emptyMessage="Não existem etiquetas compatíveis com as tarefas selecionadas." onChange={setBulkLabels}/></div>
        <button type="button" className="secondary-action" disabled={Boolean(busy) || !selectedTasks.length || !applicableLabels.length} onClick={() => applyBulk("add_labels")}>Adicionar labels</button></div>
        <div className="bulk-completion-actions"><button type="button" className="primary-action" disabled={Boolean(busy) || !selectedTasks.some((task) => task.status !== "done")} onClick={() => applyBulk("close")}>{busy === "bulk" && <Spinner/>}Fechar selecionadas</button>
        </div>
        </div>
      </details>;
  const taskFilterControls = <>
    <div className="task-filter-row"><div className="filters">{[["todo", "A fazer"], ["mine", "Minhas tarefas"], ["others", "Pendentes de outros intervenientes"], ["done", "Concluídas"], ["all", "Todas"]].map(([value, label]) => <button type="button" className={filter === value ? "active" : ""} onClick={() => setFilter(value)} key={value}>{label}</button>)}</div>{showSections && <div className="view-switch" aria-label="Apresentação das tarefas">{[["list", "Lista"], ["board", "Quadro"]].map(([value, text]) => <button type="button" key={value} aria-pressed={layout === value} className={layout === value ? "active" : ""} onClick={() => { setLayout(value); localStorage.setItem("taskLayout", value); }}>{text}</button>)}</div>}{!settingsFilters && (showSections || compactCreate) && !onCreateOpenChange && <TaskCreateButton formId={formId} open={showCreate} onClick={() => setShowCreate((value) => !value)}/>}</div>
    <div className="task-search-filters">
      <label className="task-search-field">Pesquisar tarefas<input type="search" placeholder="Pesquisar no título ou descrição…" value={taskSearch} onChange={(event) => setTaskSearch(event.target.value)}/></label>
      <label>Ordenar por<Select value={taskOrder} onChange={(event) => setTaskOrder(event.target.value)}><option value="default">Predefinido</option><option value="created-asc">Data de criação: crescente</option><option value="created-desc">Data de criação: decrescente</option><option value="due-asc">Data limite: crescente</option><option value="due-desc">Data limite: decrescente</option></Select></label>
      {taskSelectionControl}
    </div>
  </>;
  const labelViewControls = <>
    {showSections && <details className="label-view-manager"><summary>Gerir vistas por etiqueta</summary><form className="new-task-section" onSubmit={createSection}>
      <Select aria-label="Etiqueta da vista" value={columnTag} onChange={(event) => setColumnTag(event.target.value)}><option value="">Criar nova etiqueta…</option>{tags.filter((tag) => !sections.some((section) => section.tag === tag.id)).map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</Select>
      {!columnTag && <input aria-label="Nome da nova etiqueta" placeholder="Nome da etiqueta…" maxLength={120} value={sectionName} onChange={(event) => setSectionName(event.target.value)}/>}
      <button disabled={(!sectionName.trim() && !columnTag) || Boolean(busy)}>Adicionar vista</button></form>
      {orderedSections.map((section) => <div className="label-view-row" key={section.id}><span>{section.name}</span><button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => run(`remove-view-${section.id}`, () => api(`/task-sections/${section.id}/`, { method: "DELETE" }))}>Remover vista</button></div>)}<small>Arrasta os cabeçalhos das vistas por etiqueta para mudar a ordem. Remover uma vista preserva a etiqueta e as tarefas.</small></details>}
  </>;
  return <>
    {settingsFilters && <div className="organization-toolbar with-task-action"><Popup className="filter-panel task-settings-panel">
      <summary>Filtros e configurações <span className="filter-indicator">{activeFilterCount || ""}</span></summary>
      {settingsFilters}
      {labelViewControls}
    </Popup><TaskCreateButton formId={formId} open={showCreate} onClick={() => setShowCreate((value) => !value)}/></div>}
    {actionResult && <p className="task-action-result" role="status">{actionResult}</p>}
    {((!showSections && !compactCreate) || showCreate) && <form id={formId} className="quick-task" onSubmit={createTask}><input aria-label="Título da nova tarefa" autoFocus={showSections || compactCreate} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Adicionar uma tarefa…"/><AutoSizeTextarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Descrição (opcional)"/><label className="new-task-meeting">Reunião<Select aria-label="Reunião da nova tarefa" disabled={Boolean(busy) || Boolean(defaultSession)} value={newSession} onChange={(event) => setNewSession(event.target.value)}><option value="">Sem reunião</option>{sessions.map((session) => <option key={session.id} value={session.id}>{session.title || "Reunião sem título"}</option>)}</Select></label><button disabled={Boolean(busy) || !title.trim()}>{busy === "new" && <Spinner/>}Adicionar</button>{(showSections || compactCreate) && <button type="button" className="secondary" onClick={() => setShowCreate(false)}>Cancelar</button>}</form>}
    {taskFilterControls}
    {!settingsFilters && labelViewControls}
    {today ? <div className="today-groups">{["Atrasadas", "Hoje", "Próximos sete dias", "Sem prazo"].map((group) => {
      const groupTasks = visible.filter((task) => !["done", "cancelled"].includes(task.status) && deadlineGroup(task) === group);
      return <section key={group}><h2>{group} <small>({groupTasks.length})</small></h2><div className="card-list">{groupTasks.length ? groupTasks.map((task) => renderTask(task)) : <p className="empty">Sem tarefas.</p>}</div></section>;
    })}</div> : showSections ? <div className={`task-sections ${layout === "board" ? "task-board" : ""}`}>{groups.map((section) => {
      const key = section.id ?? "unassigned";
      const sectionTasks = tasksForLabelView(layout === "board" && section.id !== "done" ? visible.filter((task) => task.status !== "done") : visible, section, sections);
      return <section className={`task-section ${dropTarget === key ? "drop-target" : ""}`} key={key}
        onDragOver={(event) => {
          if (busy || (draggedTask.current === null && draggedSection.current === null)) return;
          if (draggedSection.current !== null && section.tag == null) return;
          event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTarget(key);
        }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDropTarget((current) => current === key ? null : current); }}
        onDrop={(event) => draggedSection.current !== null ? reorderSections(event, section) : moveTask(event, section)}>
        <button type="button" className="task-section-heading" aria-expanded={!section.collapsed} aria-controls={`task-section-${key}`} disabled={Boolean(busy)}
          draggable={section.tag != null && !busy}
          title={section.tag != null ? "Arrastar para reorganizar este separador" : undefined}
          onDragStart={(event) => {
            if (busy || section.tag == null) { event.preventDefault(); return; }
            event.stopPropagation(); draggedTask.current = null; draggedSection.current = section.id;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("application/x-notetaker-section", String(section.id));
          }}
          onDragEnd={() => { draggedSection.current = null; setDropTarget(null); }}
          onClick={() => toggleSection(section)}><span aria-hidden="true">{section.collapsed ? "▸" : "▾"}</span><strong>{section.name}</strong><span className="task-section-count">{sectionTasks.length}</span></button>
        <div id={`task-section-${key}`} className="card-list task-section-body" hidden={section.collapsed && !sectionTasks.some((task) => task.id === targetId)}>{sectionTasks.length ? sectionTasks.map((task) => renderTask(task, section)) : <div className="empty">Sem tarefas nesta vista. Arrasta uma tarefa para aqui.</div>}</div>
      </section>;
    })}</div> : <div className="card-list">{visible.length ? visible.map((task) => renderTask(task)) : <div className="empty">Não existem tarefas nesta vista.</div>}</div>}
  </>;
}

function ListeningLogs({ logs }) {
  return <div className="card-list logs-list">{logs.length === 0 ? <div className="empty">Não existem registos recentes da escuta ativa.</div> : logs.map((log) => <article className="card log-entry" key={log.id}><time>{new Date(log.recorded_at).toLocaleString()}</time><span>{log.language?.toUpperCase() || "Idioma desconhecido"}</span><p>{log.text}</p></article>)}</div>;
}

// The date picker always includes recent summaries, separate from the Today summary.
function DailySummaryPicker({ summaries, date, onDateChange, busy, onGenerate }) {
  const [selectedId, setSelectedId] = useState(null);
  const selected = summaries.find((item) => item.id === selectedId);
  return <Popup><summary aria-label="Escolher data do resumo">▾</summary>
    <div className="daily-summary-menu">
      <strong>Escolher outro dia</strong>
      <form onSubmit={onGenerate}><input aria-label="Data do resumo" type="date" max={localDateValue()} value={date} onChange={(event) => onDateChange(event.target.value)}/><button disabled={!date || busy}>Gerar resumo</button></form>
      <section className="daily-summary-history" aria-label="Últimos cinco resumos diários">
        {!summaries.length && <p className="muted">Ainda não existem resumos diários.</p>}
        <div className="daily-history-list">{summaries.map((item) => <button type="button" aria-pressed={selectedId === item.id} key={item.id} onClick={() => setSelectedId(item.id)}>
          <strong>{item.summary_date ? `Resumo de ${formatCalendarDate(item.summary_date)}` : "Resumo diário"}</strong>
          <small>Gerado em {new Date(item.created_at).toLocaleString("pt-PT")}</small>
        </button>)}</div>
        {selected && <SummaryCard summary={selected} title={selected.summary_date ? `Resumo de ${formatCalendarDate(selected.summary_date)}` : "Resumo diário"}/>}
      </section>
    </div>
  </Popup>;
}

function SummaryCard({ summary, title = "Resumo" }) {
  return <article className="card summary"><h3>{title}</h3><p>{summary.content}</p>{summary.decisions?.length > 0 && <><h4>Decisões</h4><ul>{summary.decisions.map((item, index) => <li key={index}>{item}</li>)}</ul></>}{summary.open_questions?.length > 0 && <><h4>Questões em aberto</h4><ul>{summary.open_questions.map((item, index) => <li key={index}>{item}</li>)}</ul></>}</article>;
}

function ProcessingBadge({ processing, onRetry, onCancel, retrying = false, cancelling = false }) {
  if (!processing || processing.state === "idle") return null;
  const active = ["pending", "processing"].includes(processing.state);
  const transcribing = processing.phase === "transcription";
  const counters = [
    processing.microphone_total_chunks > 0 && `${processing.microphone_completed_chunks}/${processing.microphone_total_chunks} microfone`,
    processing.system_total_chunks > 0 && `${processing.system_completed_chunks}/${processing.system_total_chunks} áudio do PC`,
  ].filter(Boolean).join(" · ");
  const elapsed = active ? formatElapsedTime(processing.processing_started_at) : "";
  const progress = active && !transcribing ? ` · ${processing.progress_percent}%` : "";
  return <span className={`status-badge ${processing.state}`}>{active && <Spinner/>}{processing.message}{transcribing && counters && ` · ${counters}`}{progress}{elapsed && ` · ${elapsed}`}{active && onCancel && <button onClick={onCancel} disabled={cancelling}>{cancelling && <Spinner/>}Cancelar</button>}{processing.retryable && onRetry && <button onClick={onRetry} disabled={retrying}>{retrying && <Spinner/>}Repetir</button>}</span>;
}

function Meetings({ sessions, refresh, onError, target, onNotice, projects, tags, tasks, taskProps }) {
  const [selected, setSelected] = useState(null);
  const [note, setNote] = useState("");
  const [title, setTitle] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingSpeaker, setEditingSpeaker] = useState(null);
  const [busy, setBusy] = useState("");
  const [editingTranscript, setEditingTranscript] = useState(null);
  // Keep panels mounted to retain drafts and include every panel in PDF output.
  const [meetingPanel, setMeetingPanel] = useState("Resumo");
  const open = async (id) => {
    try { const meeting = await api(`/sessions/${id}/`); setSelected(meeting); setTitle(meeting.title); setEditingTitle(false); setEditingSpeaker(null); }
    catch (error) { onError(error.message); }
  };
  useEffect(() => {
    if (!target?.meetingId) return;
    setMeetingPanel(target.segmentId ? "Transcrição" : target.noteId ? "Notas" : "Resumo");
    open(target.meetingId);
  }, [target?.meetingId, target?.segmentId, target?.noteId, target?.nonce]);
  useEffect(() => {
    if (selected?.id !== target?.meetingId) return;
    const frame = requestAnimationFrame(() => {
      const anchor = target?.segmentId ? `segment-${target.segmentId}` : target?.noteId ? `note-${target.noteId}` : null;
      if (anchor) document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [selected?.id, target?.segmentId, target?.noteId, target?.nonce, meetingPanel]);
  useEffect(() => { if (selected?.title) setTitle(selected.title); }, [selected?.title]);
  useEffect(() => {
    if (!selected?.id) return undefined;
    const timer = setInterval(() => {
      api(`/sessions/${selected.id}/`).then(setSelected).catch((error) => onError(error.message));
    }, 5000);
    return () => clearInterval(timer);
  }, [selected?.id, onError]);
  const run = async (key, operation) => {
    setBusy(key);
    try { await operation(); if (selected) await open(selected.id); await refresh(); }
    catch (error) { onError(error.message); }
    finally { setBusy(""); }
  };
  const saveTitle = async () => {
    if (title.trim() && title.trim() !== selected.title) await run("rename", () => api(`/sessions/${selected.id}/`, { method: "PATCH", body: JSON.stringify({ title: title.trim() }) }));
    setEditingTitle(false);
  };
  const setLanguage = (language) => run("language", () => api(`/sessions/${selected.id}/set_language/`, { method: "POST", body: JSON.stringify({ language }) }));
  const renameSpeaker = (speaker, label) => label.trim() && label.trim() !== speaker.label && run(`speaker-${speaker.id}`, () => api(`/speakers/${speaker.id}/`, { method: "PATCH", body: JSON.stringify({ label: label.trim() }) }));
  const saveSpeaker = async (speaker) => {
    await renameSpeaker(speaker, editingSpeaker.label);
    setEditingSpeaker(null);
  };
  const mergeSpeaker = (speaker) => run(`merge-${speaker.id}`, () => api(`/speakers/${speaker.id}/merge_into_others/`, { method: "POST" }));
  const exportMarkdown = () => run("markdown", async () => { const content = await apiText(`/sessions/${selected.id}/markdown/`); await window.notetaker?.exportText({ content, defaultPath: `reuniao-${selected.id}.md` }); });
  const exportHtml = () => run("html", async () => { const content = await apiText(`/sessions/${selected.id}/html/`); await window.notetaker?.exportText({ content, defaultPath: `reuniao-${selected.id}.html` }); });
  const exportPdf = () => run("pdf", async () => {
    document.body.classList.add("printing-meeting");
    try {
      const output = await window.notetaker?.exportPdf({ defaultPath: `reuniao-${selected.id}.pdf` });
      if (output) onNotice?.(`PDF guardado em ${output}`);
    } finally {
      document.body.classList.remove("printing-meeting");
    }
  });
  const retryProcessing = () => run("retry", () => api(`/sessions/${selected.id}/retry_processing/`, { method: "POST" }));
  const cancelProcessing = () => run("cancel", () => api(`/sessions/${selected.id}/cancel_processing/`, { method: "POST" }));
  const regenerateSummary = () => run("summary", () => api(`/sessions/${selected.id}/regenerate_summary/`, { method: "POST" }));
  const regenerateTasks = () => run("tasks", () => api(
    `/sessions/${selected.id}/regenerate_tasks/`, { method: "POST" }
  ));
    const retranscribe = () => window.confirm(
    "Voltar a transcrever substituirá apenas a transcrição. O resumo e as tarefas não serão recalculados. Continuar?"
  ) && run("retranscribe", () => api(`/sessions/${selected.id}/retranscribe/`, { method: "POST" }));
  const deleteMeeting = async () => {
    if (!window.confirm("Eliminar esta reunião, a transcrição e o resumo? Esta ação não pode ser anulada.")) return;
    setBusy("delete");
    try {
      await api(`/sessions/${selected.id}/`, { method: "DELETE" });
      setSelected(null);
      await refresh();
      onNotice?.("Reunião eliminada.");
    } catch (error) { onError(error.message); }
    finally { setBusy(""); }
  };
  const addNote = () => note.trim() && run("note", async () => { await api("/notes/", { method: "POST", body: JSON.stringify({ session: selected.id, body: note, project: selected.project }) }); setNote(""); });
  const groupedSegments = selected?.segments.reduce((groups, segment) => {
    const previous = groups.at(-1);
    if (previous?.speaker === segment.speaker) {
      previous.segments.push(segment);
      previous.text += ` ${segment.text}`;
      previous.endMs = Math.max(previous.endMs, segment.timeline_end_ms);
      if (segment.language && !previous.languages.includes(segment.language)) previous.languages.push(segment.language);
    } else {
      groups.push({
        id: segment.id,
        speaker: segment.speaker,
        speakerLabel: segment.speaker_label || "Desconhecido",
        languages: segment.language ? [segment.language] : [],
        segments: [segment],
        text: segment.text,
        startMs: segment.timeline_start_ms,
        endMs: segment.timeline_end_ms,
      });
    }
    return groups;
  }, []) || [];
  if (selected) return <div>
    <button className="back" onClick={() => setSelected(null)}>← Todas as reuniões</button>
    <div className="meeting-title"><div className="title-editor">{editingTitle ? <input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus/> : <h2>{selected.title || "Reunião sem título"}</h2>}<p>{new Date(selected.started_at).toLocaleString()}</p></div><div className="meeting-actions">{editingTitle ? <><button onClick={saveTitle} disabled={!title.trim() || busy === "rename"}>{busy === "rename" && <Spinner/>}Concluir</button><button onClick={() => { setTitle(selected.title); setEditingTitle(false); }}>Cancelar</button></> : <button onClick={() => setEditingTitle(true)}>Editar</button>}<Popup><summary>Exportar</summary><div className="export-menu"><button onClick={exportMarkdown} disabled={busy === "markdown"}>Markdown</button><button onClick={exportHtml} disabled={busy === "html"}>HTML</button><button onClick={exportPdf} disabled={busy === "pdf"}>PDF</button></div></Popup><button className="danger" onClick={deleteMeeting} disabled={busy === "delete"}>{busy === "delete" && <Spinner/>}Eliminar</button></div></div>
    <div className="meeting-meta"><div className="processing-actions"><ProcessingBadge processing={selected.processing} onRetry={retryProcessing} onCancel={cancelProcessing} retrying={busy === "retry"} cancelling={busy === "cancel"}/><Popup className="processing-menu">
  <summary>Reprocessar</summary>
  <div className="export-menu">
    <button onClick={retranscribe}
      disabled={busy === "retranscribe" || !selected.processing.retranscription_available}>
      {busy === "retranscribe" && <Spinner/>}Voltar a transcrever
    </button>
    <button onClick={regenerateSummary}
      disabled={busy === "summary" || ["pending", "processing"].includes(selected.processing.state)}>
      {busy === "summary" && <Spinner/>}Voltar a resumir
    </button>
    <button onClick={regenerateTasks}
      disabled={busy === "tasks" || ["pending", "processing"].includes(selected.processing.state)}>
      {busy === "tasks" && <Spinner/>}Voltar a criar tarefas
    </button>
  </div>
</Popup></div><label>Idioma <Select value={selected.language || ""} onChange={(event) => setLanguage(event.target.value)} disabled={busy === "language"}><option value="" disabled>Deteção automática</option><option value="pt">Português</option><option value="en">English</option></Select></label></div>
    <nav className="section-tabs" aria-label="Conteúdo da reunião">{["Resumo", "Transcrição", "Notas", "Tarefas", "Organização"].map((panel) => <button type="button" key={panel} className={meetingPanel === panel ? "active" : ""} aria-pressed={meetingPanel === panel} onClick={() => setMeetingPanel(panel)}>{panel}</button>)}</nav>
    <section className="meeting-panel" hidden={meetingPanel !== "Organização"}><article className="card"><h3>Projeto</h3><OrganizationFields item={selected} projects={projects} tags={tags} onSave={(changes) => run("organization", () => api(`/sessions/${selected.id}/`, { method: "PATCH", body: JSON.stringify(changes) }))}/></article>
    </section><section className="meeting-panel" hidden={meetingPanel !== "Resumo"}>
    {selected.summaries.length === 0 && <article className="card summary pending-summary">{!["failed", "cancelled"].includes(selected.processing.state) && <Spinner/>}<p>{selected.processing.state === "failed" ? "Não foi possível gerar o resumo. Usa Repetir para tentar novamente." : selected.processing.state === "cancelled" ? "O processamento desta reunião foi cancelado." : "O resumo aparecerá quando o processamento terminar."}</p></article>}
    {selected.summaries.map((summary) => <SummaryCard summary={summary} key={summary.id}/>)}
    </section><section className="meeting-panel" hidden={meetingPanel !== "Organização"}>
    {selected.speakers.length > 0 && <article className="card participants"><h3>Participantes</h3>{selected.speakers.map((speaker) => { const isEditing = editingSpeaker?.id === speaker.id; return <div className="participant-row" key={speaker.id}><div className="participant-field"><span>{speaker.kind === "self" ? "A minha voz" : "Participante"}</span>{isEditing ? <input value={editingSpeaker.label} onChange={(event) => setEditingSpeaker({ ...editingSpeaker, label: event.target.value })} autoFocus/> : <strong>{speaker.label}</strong>}</div><div className="participant-actions">{isEditing ? <><button className="text-button" onClick={() => saveSpeaker(speaker)} disabled={!editingSpeaker.label.trim() || busy === `speaker-${speaker.id}`}>Concluir</button><button className="text-button secondary-text" onClick={() => setEditingSpeaker(null)}>Cancelar</button></> : <button className="text-button" onClick={() => setEditingSpeaker({ id: speaker.id, label: speaker.label })}>Editar</button>}{speaker.kind !== "self" && speaker.label !== "Outros" && !isEditing && <button className="text-button" onClick={() => mergeSpeaker(speaker)} disabled={busy === `merge-${speaker.id}`}>{busy === `merge-${speaker.id}` && <Spinner/>}Fundir em Outros</button>}</div></div>; })}</article>}
    </section><section className="meeting-panel" hidden={meetingPanel !== "Notas"}>
    <article className="card notes"><h3>Notas pessoais</h3>{selected.notes.map((item) => <div id={`note-${item.id}`} className={target?.noteId === item.id ? "highlighted-segment" : ""} key={item.id}><p>{item.body}</p><OrganizationMenu item={item} projects={projects} tags={tags} onSave={(changes) => run(`note-${item.id}`, () => api(`/notes/${item.id}/`, { method: "PATCH", body: JSON.stringify(changes) }))}/></div>)}<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Adicionar uma nota…"/><button onClick={addNote} disabled={busy === "note"}>{busy === "note" && <Spinner/>}Guardar nota</button></article>
    </section><section className="meeting-panel" hidden={meetingPanel !== "Tarefas"}>
      <TaskList key={selected.id} {...taskProps} targetId={null} tasks={tasks.filter((task) => task.session === selected.id)} defaultSession={selected.id}/>
    </section><section className="meeting-panel" hidden={meetingPanel !== "Transcrição"}>
    {!groupedSegments.length && <p className="empty">A transcrição aparecerá quando estiver disponível.</p>}
    <div className="transcript">{groupedSegments.map((group) => {
      const editing = editingTranscript === group.id;
      const highlighted = group.segments.some((segment) => target?.segmentId === segment.id);
      return <article className={`card ${highlighted ? "highlighted-segment" : ""}`} key={group.id}>
        {group.segments.map((segment) => <span id={`segment-${segment.id}`} className="segment-anchor" key={segment.id}/>) }
        <div className="transcript-heading"><div><time className="transcript-timestamp">{formatTranscriptTime(group.startMs)}</time><strong>{group.speakerLabel}</strong><small>{group.languages.map((language) => language.toUpperCase()).join(" / ")}</small></div><button className="text-button" onClick={() => setEditingTranscript(editing ? null : group.id)}>{editing ? "Concluir" : "Editar"}</button></div>
        {editing ? <div className="segment-editors">{group.segments.map((segment) => <textarea key={segment.id} defaultValue={segment.text} onBlur={(event) => event.target.value !== segment.text && run(`segment-${segment.id}`, () => api(`/segments/${segment.id}/`, { method: "PATCH", body: JSON.stringify({ text: event.target.value }) }))}/>)}</div> : <p className="transcript-text">{group.text}</p>}
      </article>;
    })}</div></section>
  </div>;
  return <div className="card-list">{sessions.map((session) => <button className="card meeting-card" onClick={() => { setMeetingPanel("Resumo"); open(session.id); }} key={session.id}><div><h3>{session.title || "Reunião sem título"}</h3><p>{new Date(session.started_at).toLocaleString()} · {session.status} · {session.language?.toUpperCase() || "A detetar idioma"}</p></div><ProcessingBadge processing={session.processing}/></button>)}</div>;
}

function Settings({ microphoneId, setMicrophoneId, keepDisplayAwake, setKeepDisplayAwake, onError }) {
  const [devices, setDevices] = useState([]), [launchAtLogin, setLaunchAtLogin] = useState(false), [retentionDays, setRetentionDays] = useState(7), [maxGb, setMaxGb] = useState(5), [logHours, setLogHours] = useState(24), [defaultLanguage, setDefaultLanguage] = useState("pt"), [glossary, setGlossary] = useState(""), [aiModel, setAiModel] = useState(""), [ollamaAvailable, setOllamaAvailable] = useState(false), [busy, setBusy] = useState(false);
  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices().then((items) => setDevices(items.filter((item) => item.kind === "audioinput"))).catch(console.error);
    window.notetaker?.getLaunchAtLogin().then(setLaunchAtLogin).catch(console.error);
    api("/settings/").then((items) => { const values = Object.fromEntries(items.map((item) => [item.key, item.value])); if (values.audio_retention_days) setRetentionDays(values.audio_retention_days); if (values.audio_max_bytes) setMaxGb(Math.max(1, Math.round(values.audio_max_bytes / 1024 ** 3))); if (values.active_log_window_hours) setLogHours(values.active_log_window_hours); if (["pt", "en"].includes(values.default_language)) setDefaultLanguage(values.default_language); if (typeof values.transcription_glossary === "string") setGlossary(values.transcription_glossary); }).catch((error) => onError(error.message));
    api("/health/").then((health) => { setAiModel(health.model || "Não configurado"); setOllamaAvailable(Boolean(health.ollama)); }).catch((error) => onError(error.message));
  }, [onError]);
  const save = async () => {
    setBusy(true);
    try { localStorage.setItem("microphoneDeviceId", microphoneId); await window.notetaker?.setLaunchAtLogin(launchAtLogin); await api("/settings/bulk_upsert/", { method: "POST", body: JSON.stringify({ settings: {
      audio_retention_days: Number(retentionDays), audio_max_bytes: Number(maxGb) * 1024 ** 3, active_log_window_hours: Number(logHours),
      default_language: defaultLanguage, transcription_glossary: glossary,
    } }) }); } catch (error) { onError(error.message); } finally { setBusy(false); }
  };
  return <article className="settings-grid card"><div><label>Modelo para resumos, tarefas e perguntas à IA</label><strong>{aiModel || "A carregar…"} · {ollamaAvailable ? "Disponível" : "Indisponível"}</strong></div><div><label>Modelo de transcrição</label><strong>Faster Whisper Medium · PT/EN</strong></div><div><label>Microfone</label><Select value={microphoneId} onChange={(event) => setMicrophoneId(event.target.value)}><option value="">Predefinido do Windows</option>{devices.map((device) => <option value={device.deviceId} key={device.deviceId}>{device.label || "Microfone"}</option>)}</Select></div><div><label>Idioma para reuniões curtas</label><Select value={defaultLanguage} onChange={(event) => setDefaultLanguage(event.target.value)}><option value="pt">Português</option><option value="en">English</option></Select></div><div className="settings-limits wide"><label>Retenção máxima (dias)<input type="number" min="1" max="7" value={retentionDays} onChange={(event) => setRetentionDays(event.target.value)}/></label><label>Limite de áudio (GB)<input type="number" min="1" value={maxGb} onChange={(event) => setMaxGb(event.target.value)}/></label><label>Janela dos logs (horas)<input type="number" min="1" value={logHours} onChange={(event) => setLogHours(event.target.value)}/></label></div><div className="wide"><label>Glossário de nomes, empresas e siglas</label><textarea value={glossary} onChange={(event) => setGlossary(event.target.value)} placeholder="Warpcom, SecureNet, onboarding, Oracle…"/></div><label className="toggle"><input type="checkbox" checked={launchAtLogin} onChange={(event) => setLaunchAtLogin(event.target.checked)}/> Iniciar com o Windows</label><label className="toggle">
  <input type="checkbox" checked={keepDisplayAwake}
    onChange={(event) => setKeepDisplayAwake(event.target.checked)}/>
  Manter o ecrã ativo
</label><button className="save" onClick={save} disabled={busy}>{busy && <Spinner/>}Guardar definições</button></article>;
}

export default function App() {
  const [view, setView] = useState("Hoje"), [tasks, setTasks] = useState([]), [taskSections, setTaskSections] = useState([]), [sessions, setSessions] = useState([]), [summaries, setSummaries] = useState([]), [logs, setLogs] = useState([]), [meetingCapture, setMeetingCapture] = useState(null), [activeListening, setActiveListening] = useState(null), [activeEnabled, setActiveEnabled] = useState(() => localStorage.getItem("activeListeningEnabled") !== "false"), [error, setError] = useState(""), [query, setQuery] = useState(""), [results, setResults] = useState(null), [chatAnswer, setChatAnswer] = useState(null), [notice, setNotice] = useState(""), [asking, setAsking] = useState(false), [dailyJob, setDailyJob] = useState(null), [dailyDate, setDailyDate] = useState(localDateValue), [captureBusy, setCaptureBusy] = useState(false), [microphoneId, setMicrophoneId] = useState(() => localStorage.getItem("microphoneDeviceId") || ""), [meetingTarget, setMeetingTarget] = useState(null), [meetingsKey, setMeetingsKey] = useState(0);
  const [projects, setProjects] = useState([]), [tags, setTags] = useState([]), [notes, setNotes] = useState([]), [participants, setParticipants] = useState([]);
  const [gitlabStatus, setGitlabStatus] = useState(null), [gitlabBusy, setGitlabBusy] = useState(false);
  const [projectFilter, setProjectFilter] = useState(""), [tagFilter, setTagFilter] = useState(""), [participantFilter, setParticipantFilter] = useState(""), [dateFrom, setDateFrom] = useState(""), [dateTo, setDateTo] = useState("");
  const [taskTarget, setTaskTarget] = useState(null), [contentDetail, setContentDetail] = useState(null);
  const [taskCreateOpen, setTaskCreateOpen] = useState(false);
  const [keepDisplayAwake, setKeepDisplayAwake] = useState(
    () => localStorage.getItem("keepDisplayAwake") === "true"
  ); 
  const activeController = useRef(null), activeStarting = useRef(false), meetingStarting = useRef(false), activeRequested = useRef(activeEnabled);
  const answerRequest = useRef(0);
  const notificationState = useRef({ initialized: false, taskIds: new Set(), summaryIds: new Set() });
  useEffect(() => {
    localStorage.setItem("keepDisplayAwake", String(keepDisplayAwake));
    window.notetaker?.setDisplayAwake(keepDisplayAwake);
  }, [keepDisplayAwake]);
  const refresh = useCallback(async () => {
    try {
      // A failed secondary endpoint must not discard successfully loaded projects.
      const endpoints = ["tasks", "sessions", "summaries", "active-listening-logs", "task-sections", "projects", "tags", "notes", "speakers", "gitlab"];
      const setters = [setTasks, setSessions, setSummaries, setLogs, setTaskSections, setProjects, setTags, setNotes, setParticipants, setGitlabStatus];
      const loaded = await Promise.allSettled(endpoints.map((endpoint) => api(`/${endpoint}/`)));
      loaded.forEach((result, index) => { if (result.status === "fulfilled") setters[index](result.value); });
      const failures = loaded.flatMap((result, index) => result.status === "rejected" ? [`${endpoints[index]}: ${result.reason.message}`] : []);
      if (failures.length) setError(failures.join("; "));
      if (loaded.slice(0, 3).some((result) => result.status === "rejected")) return;
      const [nextTasks, nextSessions, nextSummaries] = loaded.slice(0, 3).map((result) => result.value);
      const tracked = notificationState.current;
      const nextTaskIds = new Set(nextTasks.map((task) => task.id));
      const nextSummaryIds = new Set(nextSummaries.map((summary) => summary.id));
      if (tracked.initialized) {
        const newSummaries = nextSummaries.filter((summary) => summary.kind === "meeting" && !tracked.summaryIds.has(summary.id));
        const newTasks = nextTasks.filter((task) => task.creation_source === "system" && !tracked.taskIds.has(task.id));
        tracked.summaryIds = nextSummaryIds;
        tracked.taskIds = nextTaskIds;
        for (const summary of newSummaries) {
          const meeting = nextSessions.find((session) => session.id === summary.session);
          await window.notetaker?.notify({ title: "Resumo disponível", body: meeting?.title || "O resumo da reunião está pronto.", target: { kind: "summary", object_id: summary.id, meeting_id: summary.session } });
        }
        for (const task of newTasks) {
          await window.notetaker?.notify({ title: "Nova tarefa", body: task.title, target: { kind: "task", object_id: task.id } });
        }
      } else {
        tracked.initialized = true;
        tracked.summaryIds = nextSummaryIds;
        tracked.taskIds = nextTaskIds;
      }
    } catch (nextError) { setError(nextError.message); }
  }, []);  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { const timer = setInterval(refresh, 5000); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => { if (!notice) return undefined; const timer = setTimeout(() => setNotice(""), 30_000); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => { if (!dailyJob) return undefined; const check = async () => { try { const job = await api(`/jobs/${dailyJob.id}/`); if (job.status === "complete") { setDailyJob(null); setNotice(`Resumo de ${formatCalendarDate(dailyJob.date)} concluído.`); refresh(); } if (job.status === "failed") { setDailyJob(null); setError(job.error || "Não foi possível gerar o resumo diário."); } } catch (nextError) { setDailyJob(null); setError(nextError.message); } }; check(); const timer = setInterval(check, 2000); return () => clearInterval(timer); }, [dailyJob, refresh]);
  useEffect(() => { const check = async () => { try { const due = await api("/reminders/due/"); for (const reminder of due) { await window.notetaker?.notify({ title: "Lembrete", body: reminder.task_title, target: { kind: "task", object_id: reminder.task } }); await api(`/reminders/${reminder.id}/notified/`, { method: "POST" }); } } catch (nextError) { setError(nextError.message); } }; check(); const timer = setInterval(check, 30000); return () => clearInterval(timer); }, []);
  const startActiveMode = useCallback(async () => {
    if (activeController.current || activeStarting.current || meetingStarting.current) return;
    activeStarting.current = true;
    try {
      const controller = await startActiveListening((nextError) => setError(nextError.message), microphoneId);
      if (!activeRequested.current || meetingStarting.current) { await controller.stop(); return; }
      activeController.current = controller;
      setActiveListening(controller);
      window.notetaker?.setCaptureState("active-listening");
    } catch (nextError) { setError(nextError.message); }
    finally { activeStarting.current = false; }
  }, [microphoneId]);
  const stopActiveMode = useCallback(async () => {
    const controller = activeController.current;
    activeController.current = null;
    if (controller) await controller.stop();
    setActiveListening(null);
  }, []);
  useEffect(() => {
    if (activeEnabled && !meetingCapture && !meetingStarting.current) startActiveMode();
  }, [activeEnabled, meetingCapture, startActiveMode]);
  const toggleActiveListening = async () => {
    setError(""); setCaptureBusy(true);
    try {
      if (activeEnabled) {
        activeRequested.current = false;
        setActiveEnabled(false);
        localStorage.setItem("activeListeningEnabled", "false");
        await stopActiveMode();
        window.notetaker?.setCaptureState("paused");
      } else {
        activeRequested.current = true;
        setActiveEnabled(true);
        localStorage.setItem("activeListeningEnabled", "true");
        if (!meetingCapture) await startActiveMode();
      }
    }
    catch (nextError) { setError(nextError.message); }
    finally { setCaptureBusy(false); }
  };
  // The sidebar switch controls synchronization only; write permission stays in Settings.
  const toggleGitLab = async () => {
    if (gitlabBusy || !gitlabStatus) return;
    setGitlabBusy(true); setError("");
    try {
      const status = await api("/gitlab/", { method: "PATCH", body: JSON.stringify({ enabled: !gitlabStatus.enabled }) });
      setGitlabStatus(status);
      await refresh();
    } catch (nextError) { setError(nextError.message); }
    finally { setGitlabBusy(false); }
  };
  const toggleMeeting = async () => {
    setError(""); setCaptureBusy(true);
    try {
      if (meetingCapture) {
        await meetingCapture.stop();
        setMeetingCapture(null);
        await refresh();
        if (activeEnabled) await startActiveMode();
        else window.notetaker?.setCaptureState("paused");
      } else {
        meetingStarting.current = true;
        await stopActiveMode();
        const controller = await startCapture((nextError) => setError(nextError.message), microphoneId);
        setMeetingCapture(controller);
        window.notetaker?.setCaptureState("meeting");
      }
    } catch (nextError) {
      setError(nextError.message);
      meetingStarting.current = false;
      if (activeEnabled && !meetingCapture) await startActiveMode();
    } finally {
      meetingStarting.current = false;
      setCaptureBusy(false);
    }
  };
  useEffect(() => {
    answerRequest.current += 1; setChatAnswer(null);
    const trimmedQuery = query.trim();
    if (!trimmedQuery && !projectFilter && !tagFilter && !participantFilter && !dateFrom && !dateTo) { setResults(null); return undefined; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const nextResults = await api(`/search/?${new URLSearchParams({ q: trimmedQuery, project: projectFilter, tag: tagFilter, participant: participantFilter, date_from: dateFrom, date_to: dateTo })}`);
        if (!cancelled) setResults(nextResults);
      } catch (nextError) {
        if (!cancelled) setError(nextError.message);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, projectFilter, tagFilter, participantFilter, dateFrom, dateTo]);
  const ask = async () => {
    if (!query.trim()) return;
    const requestId = ++answerRequest.current;
    setAsking(true);
    try {
      const answer = await api("/chat/", { method: "POST", body: JSON.stringify({ question: query.trim(), project: projectFilter, tag: tagFilter, participant: participantFilter, date_from: dateFrom, date_to: dateTo }) });
      if (requestId === answerRequest.current) setChatAnswer(answer);
    } catch (nextError) { if (requestId === answerRequest.current) setError(nextError.message); }
    finally { setAsking(false); }
  };
  // Resolve live content before navigation, including deleted notification targets.
  const openSource = useCallback(async (source) => {
    try {
      if (source.kind === "summary" && source.object_id) await api(`/summaries/${source.object_id}/`);
      if (source.kind === "note" && source.meeting_id) await api(`/notes/${source.object_id}/`);
      if (source.kind === "segment" && source.segment_id) await api(`/segments/${source.segment_id}/`);
      if (source.kind === "task") {
        const task = await api(`/tasks/${source.object_id}/`);
        setProjectFilter(""); setTagFilter("");
        setTasks((items) => [...items.filter((item) => item.id !== task.id), task]);
        setTaskTarget({ id: task.id, nonce: Date.now() }); setView("Tarefas"); setContentDetail(null);
      } else if (source.kind === "note" && !source.meeting_id) {
        const note = await api(`/notes/${source.object_id}/`);
        setContentDetail(note); setView("Notas");
      } else if (source.meeting_id) {
        await api(`/sessions/${source.meeting_id}/`);
        setMeetingTarget({ meetingId: source.meeting_id, segmentId: source.segment_id, noteId: source.kind === "note" ? source.object_id : null, nonce: Date.now() });
        setView("Reuniões"); setContentDetail(null);
      } else setNotice("O conteúdo associado já não está disponível.");
    } catch (nextError) { setError(`Não foi possível abrir o conteúdo: ${nextError.message}`); }
  }, []);
  useEffect(() => window.notetaker?.onNotificationOpen(openSource), [openSource]);
  const selectView = (nextView) => {
    setTaskTarget(null); setContentDetail(null);
    if (nextView !== view) setTaskCreateOpen(false);
    if (nextView === "Reuniões") { setMeetingTarget(null); setMeetingsKey((value) => value + 1); }
    setView(nextView);
  };
  const generateDaily = async (date) => { try { const job = await api("/summaries/generate_daily/", { method: "POST", body: JSON.stringify({ date }) }); setDailyJob({ id: job.job_id, date: job.summary_date }); setNotice(`A processar as reuniões e tarefas de ${formatCalendarDate(job.summary_date)} localmente.`); } catch (nextError) { setError(nextError.message); } };
  const generateSelectedDaily = (event) => {
    event.preventDefault();
    if (!dailyDate) return;
    event.currentTarget.closest("details")?.removeAttribute("open");
    generateDaily(dailyDate);
  };
  const organizationTasks = tasks.filter((item) => matchesOrganization(item, projectFilter, tagFilter, sessions, true));
  const organizationSessions = sessions.filter((item) => matchesOrganization(item, projectFilter, "", []));
  const taskProps = { gitlabStatus, sections: taskSections, refresh, onError: setError, projects, tags, sessions, onOpenSource: openSource, targetId: taskTarget?.id, targetKey: taskTarget?.nonce };
  // Creation time controls freshness; summary_date identifies the day being summarized.
  const dailySummaries = useMemo(() => summaries.filter((item) => item.kind === "daily")
    .sort((left, right) => (Date.parse(right.created_at) || 0) - (Date.parse(left.created_at) || 0) || right.id - left.id), [summaries]);
  const todayKey = localDateValue();
  const latestDaily = dailySummaries.find((item) => item.created_at && !Number.isNaN(Date.parse(item.created_at)) && localDateValue(new Date(item.created_at)) === todayKey);
  const activeOrganizationFilterCount = [projectFilter, ...(view === "Reuniões" ? [] : [tagFilter]), ...(view === "Pesquisa" ? [participantFilter, dateFrom, dateTo] : [])].filter(Boolean).length;
  const organizationFilters = <>
      <div className="search-filters">
      <label>Projeto<Select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="">Todos</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>
      {view !== "Reuniões" && <label>Etiqueta<Select value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}><option value="">Todas</option>{tags.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>}
      {view === "Pesquisa" && <><label>Participante<Select value={participantFilter} onChange={(event) => setParticipantFilter(event.target.value)}><option value="">Todos</option>{participants.map((item) => <option key={item.id} value={item.id}>{item.label} · {sessions.find((session) => session.id === item.session)?.title || "Reunião"}</option>)}</Select></label><label>Desde<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)}/></label><label>Até<input type="date" value={dateTo} min={dateFrom} onChange={(event) => setDateTo(event.target.value)}/></label></>}
      <button type="button" className="text-button" onClick={() => { setProjectFilter(""); setTagFilter(""); setParticipantFilter(""); setDateFrom(""); setDateTo(""); }}>Limpar filtros</button>
    </div>  </>;
  return <main className="shell"><aside><div className="brand"><span className="brand-mark">N</span><strong>My AI Notetaker</strong></div><nav>{VIEWS.map((item) => <button className={view === item ? "active" : ""} onClick={() => selectView(item)} key={item}>{item}</button>)}</nav><div className="sidebar-controls">
      <button type="button" className="sidebar-control" role="switch" aria-label="Escuta ativa" aria-checked={activeEnabled} disabled={captureBusy || Boolean(meetingCapture)} onClick={toggleActiveListening} title={meetingCapture ? "Reunião em curso" : activeListening ? "Escuta ativa" : "Captura pausada"}>
        <span aria-hidden="true" className={activeListening || meetingCapture ? "live-dot" : "idle-dot"}/><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg><span className="sidebar-control-label">{meetingCapture ? "Reunião em curso" : "Escuta ativa"}</span><span aria-hidden="true" className="sidebar-toggle"/>
      </button>
      <button type="button" className="sidebar-control" role="switch" aria-label="Sincronização GitLab" aria-checked={Boolean(gitlabStatus?.enabled)} disabled={gitlabBusy || !gitlabStatus || (!gitlabStatus.enabled && !gitlabStatus.has_token)} onClick={toggleGitLab} title={gitlabStatus?.error || (!gitlabStatus?.has_token ? "Configura o token GitLab nas Definições." : gitlabStatus.enabled ? "Sincronização GitLab ativa" : "Sincronização GitLab desativada")}>
        <span aria-hidden="true" className={gitlabStatus?.enabled && gitlabStatus.has_token && !gitlabStatus.error ? "live-dot" : "idle-dot"}/><span aria-hidden="true"><GitLabIcon/></span><span className="sidebar-control-label">GitLab</span><span aria-hidden="true" className="sidebar-toggle"/>
      </button>
    </div></aside><section className="content"><header><div><p className="eyebrow">LOCAL · PRIVADO</p><h1>{view}</h1></div><div className="header-actions"><div className="daily-summary-button"><button onClick={() => generateDaily(localDateValue())} disabled={Boolean(dailyJob)}>{dailyJob && <Spinner/>}Resumo do dia</button><DailySummaryPicker summaries={dailySummaries.slice(0, 5)} date={dailyDate} onDateChange={setDailyDate} busy={Boolean(dailyJob)} onGenerate={generateSelectedDaily}/></div><button className={`capture ${meetingCapture ? "active" : ""}`} onClick={toggleMeeting} disabled={captureBusy}>{captureBusy && <Spinner/>}{meetingCapture ? "Terminar reunião" : "Iniciar reunião"}</button></div></header>
    {error && <div className="error">{error}<button onClick={() => setError("")}>×</button></div>}{notice && <div className="notice">{notice}<button onClick={() => setNotice("")}>×</button></div>}
    {["Hoje", "Reuniões", "Pesquisa"].includes(view) && <div className="organization-toolbar"><Popup className="filter-panel"><summary>Filtros <span className="filter-indicator">{activeOrganizationFilterCount || ""}</span></summary>{organizationFilters}</Popup></div>}
    {view === "Notas" && <Notes notes={notes} sessions={sessions} projects={projects} tags={tags} refresh={refresh} onError={setError} onOpenSource={openSource} targetId={contentDetail?.id} OrganizationMenu={OrganizationMenu}/>}
    {view === "Projetos" && <Projects taskProps={taskProps} projects={projects} tags={tags} sessions={sessions} tasks={tasks} notes={notes} summaries={summaries} refresh={refresh} onError={setError} onOpen={openSource} onProjectSaved={(item) => setProjects((items) => [...items.filter((existing) => existing.id !== item.id), item].sort((a, b) => a.name.localeCompare(b.name)))} onTagSaved={(item) => setTags((items) => [...items.filter((existing) => existing.id !== item.id), item].sort((a, b) => a.name.localeCompare(b.name)))}/>}
    {view === "Hoje" && latestDaily && <SummaryCard summary={latestDaily} title={latestDaily.summary_date ? `Resumo de ${formatCalendarDate(latestDaily.summary_date)}` : "Resumo mais recente"}/>} {(view === "Hoje" || view === "Tarefas") && <TaskList {...taskProps} settingsFilters={view === "Tarefas" ? organizationFilters : null} activeFilterCount={activeOrganizationFilterCount} tasks={organizationTasks} today={view === "Hoje"} showSections={view === "Tarefas"} createOpen={view === "Tarefas" ? taskCreateOpen : undefined} onCreateOpenChange={view === "Tarefas" ? setTaskCreateOpen : undefined}/>} {view === "Reuniões" && <Meetings tasks={tasks} taskProps={taskProps} projects={projects} tags={tags} key={meetingsKey} sessions={organizationSessions} refresh={refresh} onError={setError} target={meetingTarget} onNotice={setNotice}/>} {view === "Pesquisa" && <><div className="search"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Pesquisar ou perguntar sobre as reuniões…"/><button type="button" onClick={ask} disabled={asking}>{asking && <Spinner/>}{asking ? "A pensar…" : "Pesquisa de IA"}</button></div>{contentDetail && <article className="card"><h3>{contentDetail.title || "Nota pessoal"}</h3><p>{contentDetail.body}</p><OrganizationMenu item={contentDetail} projects={projects} tags={tags} onSave={async (changes) => {
      try { const saved = await api(`/notes/${contentDetail.id}/`, { method: "PATCH", body: JSON.stringify(changes) }); setContentDetail(saved); await refresh(); }
      catch (nextError) { setError(nextError.message); }
    }}/><button onClick={() => setContentDetail(null)}>Fechar</button></article>}{chatAnswer && <article className="card answer"><h3>Resposta</h3><p>{chatAnswer.answer}</p>{chatAnswer.warning && <small>{chatAnswer.warning}</small>}<ReferenceInfo label="Fontes da resposta">{chatAnswer.sources?.length ? <span className="answer-sources">{chatAnswer.sources.map((source) => <button key={source.id} onClick={() => openSource(source)}><span>{source.meeting_title} · {source.speaker}</span><small>{source.text}</small></button>)}</span> : <span className="reference-text">Sem evidência suficiente.</span>}</ReferenceInfo></article>}{results && <div className="card-list search-results">{results.sources?.length ? results.sources.map((source) => <button className="card search-result" key={source.id} onClick={() => openSource(source)}><div className="search-result-meta"><span>{{segment: "Transcrição", summary: "Resumo", note: "Nota", task: "Tarefa", session: "Reunião"}[source.kind]}</span><span>{source.title || source.meeting_title}</span></div><p>{source.text}</p></button>) : <div className="empty">Não foram encontrados resultados locais.</div>}</div>}</>} {view === "Definições" && <Settings microphoneId={microphoneId} setMicrophoneId={setMicrophoneId}
  keepDisplayAwake={keepDisplayAwake} setKeepDisplayAwake={setKeepDisplayAwake} onError={setError}/>} {view === "Definições" && <GitLabSettings onError={setError} refresh={refresh}/>} {view === "Logs" && <ListeningLogs logs={logs}/>}</section></main>;
}
