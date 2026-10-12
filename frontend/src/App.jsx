import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { api, apiText } from "./api";
import Select from "./Select";
import { startActiveListening, startCapture } from "./capture";


const VIEWS = ["Hoje", "Tarefas", "Projetos", "Reuniões", "Pesquisa", "Definições", "Logs"];
const REMINDER_OPTIONS = [[0, "Na hora"], [5, "5 minutos antes"], [15, "15 minutos antes"], [30, "30 minutos antes"], [60, "1 hora antes"], [1440, "1 dia antes"]];
const TASK_PRIORITIES = [["high", "P1"], ["normal", "P2"], ["low", "P3"]];

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

function matchesOrganization(item, project, tag, sessions) {
  const meeting = sessions.find((session) => session.id === item.session);
  return (!project || String(item.project ?? meeting?.project) === String(project)) &&
    (!tag || item.tags?.includes(Number(tag)) || meeting?.tags?.includes(Number(tag)));
}

function OrganizationFields({ item, projects, tags, onSave }) {
  const [saving, setSaving] = useState(false);
  const save = async (changes) => {
    if (saving) return;
    setSaving(true);
    try { await onSave(changes); } finally { setSaving(false); }
  };
  return <div className="organization-fields">
    <label>Projeto<Select disabled={saving} value={item.project || ""} onChange={(event) => save({ project: event.target.value ? Number(event.target.value) : null })}>
      <option value="">Sem projeto</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
    </Select></label>
    <fieldset><legend>Etiquetas</legend>{tags.length ? tags.map((tag) => <label className="tag-choice" key={tag.id}><input disabled={saving} type="checkbox" checked={item.tags?.includes(tag.id) || false}
      onChange={(event) => save({ tags: event.target.checked ? [...(item.tags || []), tag.id] : (item.tags || []).filter((id) => id !== tag.id) })}/>{tag.name}</label>) : <small>Cria etiquetas em Projetos.</small>}</fieldset>
  </div>;
}

// Assignment controls sit beside actions, keeping the reading flow clear.
function OrganizationMenu(props) {
  const project = props.projects.find((item) => item.id === props.item.project);
  const labels = props.tags.filter((item) => props.item.tags?.includes(item.id));
  return <details className="organization-menu"><summary aria-label="Organizar projeto e etiquetas" title={[project?.name, ...labels.map((item) => item.name)].filter(Boolean).join(" · ") || "Projeto e etiquetas"}>Organizar</summary>
    <div className="organization-panel"><h4>Projeto e etiquetas</h4><OrganizationFields {...props}/></div>
  </details>;
}

// References reveal their evidence and source links on hover, focus or click.
function ReferenceInfo({ children, label = "Referências" }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <span className="reference-info" onMouseEnter={() => setOpen(true)} onMouseLeave={(event) => { if (!event.currentTarget.contains(document.activeElement)) setOpen(false); }}
    onFocus={() => setOpen(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } }}>
    <button type="button" className="info-button" aria-label={label} aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(true)}>ⓘ</button>
    {open && <span id={id} className="reference-panel" role="region" aria-label={label}>{children}</span>}
  </span>;
}

function Projects({ projects, tags, sessions, tasks, notes, summaries, refresh, onError, onOpen, taskProps, onProjectSaved, onTagSaved }) {
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
  const projectTasks = tasks.filter((item) => matchesOrganization(item, project?.id, "", sessions));
  const projectNotes = notes.filter((item) => matchesOrganization(item, project?.id, "", sessions));
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
  return <div className="projects-workspace">
    {project && <button type="button" className="back" onClick={() => { setSelected(null); setForm(null); }}>← Todos os projetos</button>}
    <div className="projects-heading"><div><h2>{project ? "Projeto" : "Os teus projetos"}</h2><p>Reuniões, notas e tarefas organizadas por projeto.</p></div><div className="form-actions"><button type="button" className="primary-action" disabled={Boolean(busy)} onClick={() => { setEditingProject(null); setForm(form === "project" ? null : "project"); }}>Novo projeto</button><button type="button" className="secondary-action" disabled={Boolean(busy)} onClick={() => { setEditingTag(null); setForm(form === "tags" ? null : "tags"); }}>Gerir etiquetas</button></div></div>
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
        <div className="tag-management">{tags.map((tag) => <button type="button" className="tag-pill" key={tag.id} disabled={Boolean(busy)} onClick={() => { setEditingTag({ ...tag }); setFormError({}); }}>{tag.name}<span aria-hidden="true">✎</span><span className="sr-only">Editar etiqueta</span></button>)}</div>
      </div>}
    </div>}
    {!project && (projects.length ? <div className="project-grid">{projects.map((item) => <button type="button" className={`project-tile ${selected === item.id ? "selected" : ""}`} aria-pressed={selected === item.id} key={item.id} onClick={() => setSelected(item.id)}><strong>{item.name}</strong><p>{item.description || "Sem descrição"}</p><small>{sessions.filter((session) => session.project === item.id).length} reuniões · {tasks.filter((task) => matchesOrganization(task, item.id, "", sessions)).length} tarefas</small></button>)}</div> : <div className="project-empty"><strong>A tua próxima reunião pode ter um lugar.</strong><p>Usa “Novo projeto” para começar e associa-lhe reuniões ou tarefas.</p></div>)}
    {project && <section className="project-detail">
      <div className="projects-heading"><div><h2>{project.name}</h2><p>{project.description}</p><small>{projectSessions.length} reuniões · {projectTasks.length} tarefas · {projectNotes.length} notas</small></div><button type="button" className="secondary-action" disabled={Boolean(busy)} onClick={() => { setEditingProject({ ...project }); setFormError({}); setForm("project"); }}>Editar projeto</button></div>
      <h3>Reuniões e decisões</h3><div className="card-list">{projectSessions.length ? projectSessions.map((item) => <button className="card project-meeting" key={item.id} onClick={() => onOpen({ kind: "session", object_id: item.id, meeting_id: item.id })}><strong>{item.title || "Reunião sem título"}</strong><small>{new Date(item.started_at).toLocaleDateString()}</small></button>) : <p className="empty">Associa uma reunião a este projeto para consultar as suas decisões aqui.</p>}</div>
      {summaries.filter((item) => item.kind === "meeting" && projectSessions.some((session) => session.id === item.session)).map((summary) => <SummaryCard key={summary.id} summary={summary} title={projectSessions.find((session) => session.id === summary.session)?.title || "Resumo"}/>)}
      <h3>Notas</h3><div className="card-list">{projectNotes.length ? projectNotes.map((item) => <button className="card" key={item.id} onClick={() => onOpen({ kind: "note", object_id: item.id, meeting_id: item.session })}>{item.title || "Nota pessoal"}<p>{item.body}</p></button>) : <p className="empty">Ainda não existem notas neste projeto.</p>}</div>
      <h3>Tarefas</h3><TaskList key={project.id} {...taskProps} tasks={projectTasks} defaultProject={project.id}/>
    </section>}
  </div>;
}

function TaskList({ tasks, sections = [], showSections, refresh, onError, today, projects = [], tags = [], onOpenSource, targetId, targetKey, defaultProject = null }) {
  const [title, setTitle] = useState(""), [description, setDescription] = useState("");
  const [priority, setPriority] = useState("normal"), [sectionName, setSectionName] = useState("");
  const [taskSearch, setTaskSearch] = useState(""), [priorityFilter, setPriorityFilter] = useState("all"), [taskOrder, setTaskOrder] = useState("default");
  const [unassignedCollapsed, setUnassignedCollapsed] = useState(false), [dropTarget, setDropTarget] = useState(null);
  const draggedTask = useRef(null);
  const [filter, setFilter] = useState("todo"), [editingTask, setEditingTask] = useState(null), [scheduleTask, setScheduleTask] = useState(null);
  const [dueAt, setDueAt] = useState(""), [minutesBefore, setMinutesBefore] = useState(15), [busy, setBusy] = useState(null);
  const run = async (key, operation) => {
    setBusy(key);
    try { await operation(); await refresh(); return true; }
    catch (error) { onError(error.message); return false; }
    finally { setBusy(null); }
  };
  const createTask = async (event) => {
    event.preventDefault();
    if (!title.trim()) return;
    const saved = await run("new", () => api("/tasks/", { method: "POST", body: JSON.stringify({ title: title.trim(), description: description.trim(), priority, owner: "self", status: "todo", project: defaultProject }) }));
    if (saved) { setTitle(""); setDescription(""); setPriority("normal"); }
  };
  // Persist section changes through the same API/refresh flow as task edits.
  const createSection = async (event) => {
    event.preventDefault();
    if (!sectionName.trim() || busy) return;
    const saved = await run("new-section", () => api("/task-sections/", {
      method: "POST", body: JSON.stringify({ name: sectionName.trim() }),
    }));
    if (saved) setSectionName("");
  };
  const toggleSection = (section) => {
    if (section.id === null) { setUnassignedCollapsed((value) => !value); return; }
    return run(`section-${section.id}`, () => api(`/task-sections/${section.id}/`, {
      method: "PATCH", body: JSON.stringify({ collapsed: !section.collapsed }),
    }));
  };
  // Dropping on the whole section also supports empty and collapsed groups.
  const moveTask = async (event, sectionId) => {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);
    const taskId = draggedTask.current;
    draggedTask.current = null;
    const task = tasks.find((item) => item.id === taskId);
    if (!task || busy || (task.section ?? null) === sectionId) return;
    await run(`move-${task.id}`, () => api(`/tasks/${task.id}/`, {
      method: "PATCH", body: JSON.stringify({ section: sectionId }),
    }));
  };
  const editSchedule = (task) => {
    setScheduleTask(task.id);
    setMinutesBefore(task.reminder_minutes_before ?? 15);
    if (task.due_at) {
      const date = new Date(task.due_at);
      date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
      setDueAt(date.toISOString().slice(0, 16));
    } else setDueAt("");
  };
  const saveSchedule = async (task) => {
    if (!dueAt) return;
    const saved = await run(`schedule-${task.id}`, () => api(`/tasks/${task.id}/schedule/`, {
      method: "POST",
      body: JSON.stringify({ due_at: new Date(dueAt).toISOString(), minutes_before: Number(minutesBefore) }),
    }));
    if (saved) setScheduleTask(null);
  };
  const beginTaskEdit = (task) => setEditingTask({ id: task.id, title: task.title, description: task.description || "", owner: task.owner, owner_name: task.owner_name || "", priority: task.priority });
  const saveTask = async () => {
    if (!editingTask?.title.trim()) return;
    const saved = await run(`edit-${editingTask.id}`, () => api(`/tasks/${editingTask.id}/`, { method: "PATCH", body: JSON.stringify({
      title: editingTask.title.trim(), description: editingTask.description.trim(), owner: editingTask.owner,
      owner_name: editingTask.owner === "other" ? editingTask.owner_name.trim() : "",
      priority: editingTask.priority,
    }) }));
    if (saved) setEditingTask(null);
  };
  const deleteTask = async (task) => {
    if (!window.confirm(`Eliminar a tarefa “${task.title}”?`)) return;
    await run(`delete-${task.id}`, () => api(`/tasks/${task.id}/`, { method: "DELETE" }));
  };
  // Search and priority narrow the selected status/owner view before sorting.
  const searchTerm = taskSearch.trim().toLocaleLowerCase("pt-PT");
  const visible = tasks.filter((task) => {
    if (priorityFilter !== "all" && task.priority !== priorityFilter) return false;
    if (searchTerm && !`${task.title}\n${task.description || ""}`.toLocaleLowerCase("pt-PT").includes(searchTerm)) return false;
    if (filter === "all") return true;
    if (filter === "done") return task.status === "done";
    if (filter === "mine") return task.owner === "self" && !["done", "cancelled"].includes(task.status);
    if (filter === "others") return task.owner === "other" && !["done", "cancelled"].includes(task.status);
    return !["done", "cancelled"].includes(task.status);
  }).sort((left, right) => compareTasks(left, right, taskOrder));
  // Targets override filters and folded groups so notification navigation is visible.
  useEffect(() => { if (targetId) { setFilter("all"); setTaskSearch(""); setPriorityFilter("all"); } }, [targetId, targetKey]);
  useEffect(() => {
    if (!targetId) return;
    const frame = requestAnimationFrame(() => document.getElementById(`task-${targetId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
    return () => cancelAnimationFrame(frame);
  }, [targetId, targetKey, tasks, filter, taskSearch, priorityFilter]);
  const renderTask = (task) => {
        const overdue = task.status !== "done" && task.due_at && new Date(task.due_at).getTime() < Date.now();
        const reminderFired = task.status !== "done" && task.reminder_status === "notified";
        const alertClass = overdue ? "overdue" : reminderFired ? "reminder-fired" : "";
        const isEditing = editingTask?.id === task.id;
        return <article id={`task-${task.id}`} className={`card task ${alertClass} ${targetId === task.id ? "highlighted-segment" : ""}`} key={task.id}>
        {showSections && <button type="button" className="task-drag-handle" aria-label={`Arrastar tarefa ${task.title}`} title="Arrastar para outro separador" disabled={Boolean(busy) || isEditing} draggable={!busy && !isEditing}
          onDragStart={(event) => { draggedTask.current = task.id; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", String(task.id)); }}
          onDragEnd={() => { draggedTask.current = null; setDropTarget(null); }}>⠿</button>}
        {(overdue || reminderFired) && <span className="task-alert" title={overdue ? "Prazo ultrapassado" : "Lembrete emitido"}>!</span>}
        <button className={`check ${task.status === "done" ? "done" : ""}`} title={task.status === "done" ? "Reabrir tarefa" : "Concluir tarefa"} disabled={busy === `status-${task.id}`} onClick={() => run(`status-${task.id}`, () => api(`/tasks/${task.id}/${task.status === "done" ? "reopen" : "complete"}/`, { method: "POST" }))}>✓</button>
        <div className="task-body">
          <div className="task-card-header">
            {isEditing ? <input className="task-title-input" value={editingTask.title} onChange={(event) => setEditingTask({ ...editingTask, title: event.target.value })}/> : <h3>{task.title}</h3>}
            <div className="item-actions">{!isEditing && <OrganizationMenu item={task} projects={projects} tags={tags} onSave={(changes) => run(`organization-${task.id}`, () => api(`/tasks/${task.id}/`, { method: "PATCH", body: JSON.stringify(changes) }))}/>} {isEditing ? <><button className="text-button" onClick={saveTask} disabled={!editingTask.title.trim() || busy === `edit-${task.id}`}>{busy === `edit-${task.id}` && <Spinner/>}Concluir</button><button className="text-button secondary-text" onClick={() => setEditingTask(null)}>Cancelar</button></> : <><button className="text-button" onClick={() => beginTaskEdit(task)}>Editar</button><button className="text-button danger" onClick={() => deleteTask(task)} disabled={busy === `delete-${task.id}`}>{busy === `delete-${task.id}` && <Spinner/>}Eliminar</button></>}</div>
          </div>
          {isEditing ? <AutoSizeTextarea className="task-description-input" value={editingTask.description} onChange={(event) => setEditingTask({ ...editingTask, description: event.target.value })} placeholder="Descrição (opcional)"/> : task.description && <p className="task-description">{task.description}</p>}

          
          <div className={`task-meta ${isEditing ? "editing" : ""}`}>
            {(task.evidence || task.source_segment || task.session) && <ReferenceInfo>{task.evidence && <span className="reference-text">{task.evidence}</span>}{(task.source_segment || task.session) && <button type="button" className="text-button" onClick={() => onOpenSource?.({ kind: "segment", meeting_id: task.source_meeting_id || task.session, segment_id: task.source_segment })}>Ver na reunião{task.source_start_ms != null ? ` · ${formatTranscriptTime(task.source_start_ms)}` : ""}</button>}</ReferenceInfo>}
            {isEditing ? <><Select aria-label="Responsável da tarefa" value={editingTask.owner} onChange={(event) => setEditingTask({ ...editingTask, owner: event.target.value })}><option value="self">Eu</option><option value="other">Outro interveniente</option><option value="unknown">Por definir</option></Select>{editingTask.owner === "other" && <input value={editingTask.owner_name} onChange={(event) => setEditingTask({ ...editingTask, owner_name: event.target.value })} placeholder="Nome do responsável"/>}</> : <span>{task.owner === "self" ? "Eu" : task.owner_name || "Outro interveniente"}</span>}
            {isEditing ? <Select className="task-priority-select" aria-label="Prioridade da tarefa" value={editingTask.priority} onChange={(event) => setEditingTask({ ...editingTask, priority: event.target.value })}>{TASK_PRIORITIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select> : <span className={`task-priority priority-${task.priority}`}>{TASK_PRIORITIES.find(([value]) => value === task.priority)?.[1] || "P2"}</span>}
            {!isEditing && <span>· Criada a {new Date(task.created_at).toLocaleString()} {task.creation_source === "system" ? "pelo Sistema" : "por ti"}</span>}
            {task.due_at && <span>· Limite: {new Date(task.due_at).toLocaleString()}</span>}
            {task.reminder_at && <span>· Lembrete: {new Date(task.reminder_at).toLocaleString()}</span>}
            <button className="text-button" onClick={() => editSchedule(task)}>{task.due_at || task.reminder_at ? "Alterar" : "Definir data e lembrete"}</button>
            {task.due_is_ambiguous && <span className="warning">Data por confirmar</span>}
            {scheduleTask === task.id && <div className="schedule-editor"><input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)}/><Select value={minutesBefore} onChange={(event) => setMinutesBefore(event.target.value)}>{REMINDER_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</Select><button onClick={() => saveSchedule(task)} disabled={!dueAt || busy === `schedule-${task.id}`}>{busy === `schedule-${task.id}` && <Spinner/>}Guardar</button><button className="secondary" onClick={() => setScheduleTask(null)}>Cancelar</button></div>}
          </div>
        </div>
      </article>;
  };
  const groups = [{ id: null, name: "Sem separador", collapsed: unassignedCollapsed }, ...sections];
  return <>
    <form className="quick-task" onSubmit={createTask}><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Adicionar uma tarefa…"/><AutoSizeTextarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Descrição (opcional)"/><Select aria-label="Prioridade da nova tarefa" value={priority} onChange={(event) => setPriority(event.target.value)}>{TASK_PRIORITIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select><button disabled={Boolean(busy)}>{busy === "new" && <Spinner/>}Adicionar</button></form>
    <div className="filters">{[["todo", "A fazer"], ["mine", "Minhas tarefas"], ["others", "Pendentes de outros intervenientes"], ["done", "Concluídas"], ["all", "Todas"]].map(([value, label]) => <button type="button" className={filter === value ? "active" : ""} onClick={() => setFilter(value)} key={value}>{label}</button>)}</div>
    <div className="task-search-filters">
      <label className="task-search-field">Pesquisar tarefas<input type="search" placeholder="Pesquisar no título ou descrição…" value={taskSearch} onChange={(event) => setTaskSearch(event.target.value)}/></label>
      <label>Prioridade<Select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)}><option value="all">Todas</option>{TASK_PRIORITIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></label>
      <label>Ordenar por<Select value={taskOrder} onChange={(event) => setTaskOrder(event.target.value)}><option value="default">Predefinido</option><option value="created-asc">Data de criação: crescente</option><option value="created-desc">Data de criação: decrescente</option><option value="due-asc">Data limite: crescente</option><option value="due-desc">Data limite: decrescente</option></Select></label>
    </div>
    {showSections && <form className="new-task-section" onSubmit={createSection}><input aria-label="Nome do novo separador" placeholder="Nome do separador…" maxLength={120} value={sectionName} onChange={(event) => setSectionName(event.target.value)}/><button disabled={!sectionName.trim() || Boolean(busy)}>{busy === "new-section" && <Spinner/>}Criar separador</button></form>}
    {today ? <div className="today-groups">{["Atrasadas", "Hoje", "Próximos sete dias", "Sem prazo"].map((group) => {
      const groupTasks = visible.filter((task) => !["done", "cancelled"].includes(task.status) && deadlineGroup(task) === group);
      return <section key={group}><h2>{group} <small>({groupTasks.length})</small></h2><div className="card-list">{groupTasks.length ? groupTasks.map(renderTask) : <p className="empty">Sem tarefas.</p>}</div></section>;
    })}</div> : showSections ? <div className="task-sections">{groups.map((section) => {
      const key = section.id ?? "unassigned";
      const sectionTasks = visible.filter((task) => (task.section ?? null) === section.id);
      return <section className={`task-section ${dropTarget === key ? "drop-target" : ""}`} key={key}
        onDragOver={(event) => { if (draggedTask.current === null || busy) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTarget(key); }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDropTarget((current) => current === key ? null : current); }}
        onDrop={(event) => moveTask(event, section.id)}>
        <button type="button" className="task-section-heading" aria-expanded={!section.collapsed} aria-controls={`task-section-${key}`} disabled={Boolean(busy)} onClick={() => toggleSection(section)}><span aria-hidden="true">{section.collapsed ? "▸" : "▾"}</span><strong>{section.name}</strong><span className="task-section-count">{sectionTasks.length}</span></button>
        <div id={`task-section-${key}`} className="card-list task-section-body" hidden={section.collapsed && !sectionTasks.some((task) => task.id === targetId)}>{sectionTasks.length ? sectionTasks.map(renderTask) : <div className="empty">Sem tarefas nesta vista. Arrasta uma tarefa para aqui.</div>}</div>
      </section>;
    })}</div> : <div className="card-list">{visible.length ? visible.map(renderTask) : <div className="empty">Não existem tarefas nesta vista.</div>}</div>}
  </>;
}

function ListeningLogs({ logs }) {
  return <div className="card-list logs-list">{logs.length === 0 ? <div className="empty">Não existem registos recentes da escuta ativa.</div> : logs.map((log) => <article className="card log-entry" key={log.id}><time>{new Date(log.recorded_at).toLocaleString()}</time><span>{log.language?.toUpperCase() || "Idioma desconhecido"}</span><p>{log.text}</p></article>)}</div>;
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

function Meetings({ sessions, refresh, onError, target, onNotice, projects, tags }) {
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
  const addNote = () => note.trim() && run("note", async () => { await api("/notes/", { method: "POST", body: JSON.stringify({ session: selected.id, body: note, project: selected.project, tags: selected.tags || [] }) }); setNote(""); });
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
    <div className="meeting-title"><div className="title-editor">{editingTitle ? <input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus/> : <h2>{selected.title || "Reunião sem título"}</h2>}<p>{new Date(selected.started_at).toLocaleString()}</p></div><div className="meeting-actions">{editingTitle ? <><button onClick={saveTitle} disabled={!title.trim() || busy === "rename"}>{busy === "rename" && <Spinner/>}Concluir</button><button onClick={() => { setTitle(selected.title); setEditingTitle(false); }}>Cancelar</button></> : <button onClick={() => setEditingTitle(true)}>Editar</button>}<details><summary>Exportar</summary><div className="export-menu"><button onClick={exportMarkdown} disabled={busy === "markdown"}>Markdown</button><button onClick={exportHtml} disabled={busy === "html"}>HTML</button><button onClick={exportPdf} disabled={busy === "pdf"}>PDF</button></div></details><button className="danger" onClick={deleteMeeting} disabled={busy === "delete"}>{busy === "delete" && <Spinner/>}Eliminar</button></div></div>
    <div className="meeting-meta"><div className="processing-actions"><ProcessingBadge processing={selected.processing} onRetry={retryProcessing} onCancel={cancelProcessing} retrying={busy === "retry"} cancelling={busy === "cancel"}/><details className="processing-menu">
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
</details></div><label>Idioma <Select value={selected.language || ""} onChange={(event) => setLanguage(event.target.value)} disabled={busy === "language"}><option value="" disabled>Deteção automática</option><option value="pt">Português</option><option value="en">English</option></Select></label></div>
    <nav className="section-tabs" aria-label="Conteúdo da reunião">{["Resumo", "Transcrição", "Notas", "Organização"].map((panel) => <button type="button" key={panel} className={meetingPanel === panel ? "active" : ""} aria-pressed={meetingPanel === panel} onClick={() => setMeetingPanel(panel)}>{panel}</button>)}</nav>
    <section className="meeting-panel" hidden={meetingPanel !== "Organização"}><article className="card"><h3>Projeto e etiquetas</h3><OrganizationFields item={selected} projects={projects} tags={tags} onSave={(changes) => run("organization", () => api(`/sessions/${selected.id}/`, { method: "PATCH", body: JSON.stringify(changes) }))}/></article>
    </section><section className="meeting-panel" hidden={meetingPanel !== "Resumo"}>
    {selected.summaries.length === 0 && <article className="card summary pending-summary">{!["failed", "cancelled"].includes(selected.processing.state) && <Spinner/>}<p>{selected.processing.state === "failed" ? "Não foi possível gerar o resumo. Usa Repetir para tentar novamente." : selected.processing.state === "cancelled" ? "O processamento desta reunião foi cancelado." : "O resumo aparecerá quando o processamento terminar."}</p></article>}
    {selected.summaries.map((summary) => <SummaryCard summary={summary} key={summary.id}/>)}
    </section><section className="meeting-panel" hidden={meetingPanel !== "Organização"}>
    {selected.speakers.length > 0 && <article className="card participants"><h3>Participantes</h3>{selected.speakers.map((speaker) => { const isEditing = editingSpeaker?.id === speaker.id; return <div className="participant-row" key={speaker.id}><div className="participant-field"><span>{speaker.kind === "self" ? "A minha voz" : "Participante"}</span>{isEditing ? <input value={editingSpeaker.label} onChange={(event) => setEditingSpeaker({ ...editingSpeaker, label: event.target.value })} autoFocus/> : <strong>{speaker.label}</strong>}</div><div className="participant-actions">{isEditing ? <><button className="text-button" onClick={() => saveSpeaker(speaker)} disabled={!editingSpeaker.label.trim() || busy === `speaker-${speaker.id}`}>Concluir</button><button className="text-button secondary-text" onClick={() => setEditingSpeaker(null)}>Cancelar</button></> : <button className="text-button" onClick={() => setEditingSpeaker({ id: speaker.id, label: speaker.label })}>Editar</button>}{speaker.kind !== "self" && speaker.label !== "Outros" && !isEditing && <button className="text-button" onClick={() => mergeSpeaker(speaker)} disabled={busy === `merge-${speaker.id}`}>{busy === `merge-${speaker.id}` && <Spinner/>}Fundir em Outros</button>}</div></div>; })}</article>}
    </section><section className="meeting-panel" hidden={meetingPanel !== "Notas"}>
    <article className="card notes"><h3>Notas pessoais</h3>{selected.notes.map((item) => <div id={`note-${item.id}`} className={target?.noteId === item.id ? "highlighted-segment" : ""} key={item.id}><p>{item.body}</p><OrganizationMenu item={item} projects={projects} tags={tags} onSave={(changes) => run(`note-${item.id}`, () => api(`/notes/${item.id}/`, { method: "PATCH", body: JSON.stringify(changes) }))}/></div>)}<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Adicionar uma nota…"/><button onClick={addNote} disabled={busy === "note"}>{busy === "note" && <Spinner/>}Guardar nota</button></article>
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
  const [projectFilter, setProjectFilter] = useState(""), [tagFilter, setTagFilter] = useState(""), [participantFilter, setParticipantFilter] = useState(""), [dateFrom, setDateFrom] = useState(""), [dateTo, setDateTo] = useState("");
  const [taskTarget, setTaskTarget] = useState(null), [contentDetail, setContentDetail] = useState(null);
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
      const endpoints = ["tasks", "sessions", "summaries", "active-listening-logs", "task-sections", "projects", "tags", "notes", "speakers"];
      const setters = [setTasks, setSessions, setSummaries, setLogs, setTaskSections, setProjects, setTags, setNotes, setParticipants];
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
        setContentDetail(note); setView("Pesquisa");
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
  const organizationTasks = tasks.filter((item) => matchesOrganization(item, projectFilter, tagFilter, sessions));
  const organizationSessions = sessions.filter((item) => matchesOrganization(item, projectFilter, tagFilter, []));
  const taskProps = { sections: taskSections, refresh, onError: setError, projects, tags, onOpenSource: openSource, targetId: taskTarget?.id, targetKey: taskTarget?.nonce };
  const latestDaily = useMemo(() => summaries.find((item) => item.kind === "daily"), [summaries]);
  return <main className="shell"><aside><div className="brand"><span className="brand-mark">N</span><strong>My AI Notetaker</strong></div><nav>{VIEWS.map((item) => <button className={view === item ? "active" : ""} onClick={() => selectView(item)} key={item}>{item}</button>)}</nav><div className="privacy"><span className={activeListening || meetingCapture ? "live-dot" : "idle-dot"}/>{meetingCapture ? "Reunião em curso" : activeListening ? "Escuta ativa" : "Captura pausada"}</div></aside><section className="content"><header><div><p className="eyebrow">OFFLINE · PRIVADO</p><h1>{view}</h1></div><div className="header-actions"><div className="daily-summary-button"><button onClick={() => generateDaily(localDateValue())} disabled={Boolean(dailyJob)}>{dailyJob && <Spinner/>}Resumo do dia</button><details><summary aria-label="Escolher data do resumo">▾</summary><form onSubmit={generateSelectedDaily}><strong>Escolher outro dia</strong><input type="date" max={localDateValue()} value={dailyDate} onChange={(event) => setDailyDate(event.target.value)}/><button disabled={!dailyDate || Boolean(dailyJob)}>Gerar resumo</button></form></details></div><button className={`listening ${activeListening ? "active" : ""}`} onClick={toggleActiveListening} disabled={captureBusy || Boolean(meetingCapture)}>{activeEnabled ? "Desativar escuta" : "Ativar escuta"}</button><button className={`capture ${meetingCapture ? "active" : ""}`} onClick={toggleMeeting} disabled={captureBusy}>{captureBusy && <Spinner/>}{meetingCapture ? "Terminar reunião" : "Iniciar reunião"}</button></div></header>
    {error && <div className="error">{error}<button onClick={() => setError("")}>×</button></div>}{notice && <div className="notice">{notice}<button onClick={() => setNotice("")}>×</button></div>}
    {["Hoje", "Tarefas", "Reuniões", "Pesquisa"].includes(view) && <details className="filter-panel"><summary>Filtros <span className="filter-indicator">{[projectFilter, tagFilter, ...(view === "Pesquisa" ? [participantFilter, dateFrom, dateTo] : [])].filter(Boolean).length || ""}</span></summary>
      <div className="search-filters">
      <label>Projeto<Select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="">Todos</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>
      <label>Etiqueta<Select value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}><option value="">Todas</option>{tags.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>
      {view === "Pesquisa" && <><label>Participante<Select value={participantFilter} onChange={(event) => setParticipantFilter(event.target.value)}><option value="">Todos</option>{participants.map((item) => <option key={item.id} value={item.id}>{item.label} · {sessions.find((session) => session.id === item.session)?.title || "Reunião"}</option>)}</Select></label><label>Desde<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)}/></label><label>Até<input type="date" value={dateTo} min={dateFrom} onChange={(event) => setDateTo(event.target.value)}/></label></>}
      <button type="button" className="text-button" onClick={() => { setProjectFilter(""); setTagFilter(""); setParticipantFilter(""); setDateFrom(""); setDateTo(""); }}>Limpar filtros</button>
    </div></details>}
    {view === "Projetos" && <Projects projects={projects} tags={tags} sessions={sessions} tasks={tasks} notes={notes} summaries={summaries} refresh={refresh} onError={setError} onOpen={openSource} taskProps={taskProps} onProjectSaved={(item) => setProjects((items) => [...items.filter((existing) => existing.id !== item.id), item].sort((a, b) => a.name.localeCompare(b.name)))} onTagSaved={(item) => setTags((items) => [...items.filter((existing) => existing.id !== item.id), item].sort((a, b) => a.name.localeCompare(b.name)))}/>}
    {view === "Hoje" && latestDaily && <SummaryCard summary={latestDaily} title={latestDaily.summary_date ? `Resumo de ${formatCalendarDate(latestDaily.summary_date)}` : "Resumo mais recente"}/>} {(view === "Hoje" || view === "Tarefas") && <TaskList {...taskProps} tasks={organizationTasks} today={view === "Hoje"} showSections={view === "Tarefas"}/>} {view === "Reuniões" && <Meetings projects={projects} tags={tags} key={meetingsKey} sessions={organizationSessions} refresh={refresh} onError={setError} target={meetingTarget} onNotice={setNotice}/>} {view === "Pesquisa" && <><div className="search"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Pesquisar ou perguntar sobre as reuniões…"/><button type="button" onClick={ask} disabled={asking}>{asking && <Spinner/>}{asking ? "A pensar…" : "Pesquisa de IA"}</button></div>{contentDetail && <article className="card"><h3>{contentDetail.title || "Nota pessoal"}</h3><p>{contentDetail.body}</p><OrganizationMenu item={contentDetail} projects={projects} tags={tags} onSave={async (changes) => {
      try { const saved = await api(`/notes/${contentDetail.id}/`, { method: "PATCH", body: JSON.stringify(changes) }); setContentDetail(saved); await refresh(); }
      catch (nextError) { setError(nextError.message); }
    }}/><button onClick={() => setContentDetail(null)}>Fechar</button></article>}{chatAnswer && <article className="card answer"><h3>Resposta</h3><p>{chatAnswer.answer}</p>{chatAnswer.warning && <small>{chatAnswer.warning}</small>}<ReferenceInfo label="Fontes da resposta">{chatAnswer.sources?.length ? <span className="answer-sources">{chatAnswer.sources.map((source) => <button key={source.id} onClick={() => openSource(source)}><span>{source.meeting_title} · {source.speaker}</span><small>{source.text}</small></button>)}</span> : <span className="reference-text">Sem evidência suficiente.</span>}</ReferenceInfo></article>}{results && <div className="card-list search-results">{results.sources?.length ? results.sources.map((source) => <button className="card search-result" key={source.id} onClick={() => openSource(source)}><div className="search-result-meta"><span>{{segment: "Transcrição", summary: "Resumo", note: "Nota", task: "Tarefa", session: "Reunião"}[source.kind]}</span><span>{source.title || source.meeting_title}</span></div><p>{source.text}</p></button>) : <div className="empty">Não foram encontrados resultados locais.</div>}</div>}</>} {view === "Definições" && <Settings microphoneId={microphoneId} setMicrophoneId={setMicrophoneId}
  keepDisplayAwake={keepDisplayAwake} setKeepDisplayAwake={setKeepDisplayAwake} onError={setError}/>} {view === "Logs" && <ListeningLogs logs={logs}/>}</section></main>;
}
