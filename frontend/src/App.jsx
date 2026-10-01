import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, apiText } from "./api";
import { startActiveListening, startCapture } from "./capture";


const VIEWS = ["Hoje", "Tarefas", "Reuniões", "Pesquisa", "Definições", "Logs"];
const REMINDER_OPTIONS = [[0, "Na hora"], [5, "5 minutos antes"], [15, "15 minutos antes"], [30, "30 minutos antes"], [60, "1 hora antes"], [1440, "1 dia antes"]];

function Spinner() { return <span className="spinner" aria-hidden="true" />; }

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

function TaskList({ tasks, refresh, onError }) {
  const [title, setTitle] = useState(""), [description, setDescription] = useState("");
  const [filter, setFilter] = useState("todo"), [editingTask, setEditingTask] = useState(null), [scheduleTask, setScheduleTask] = useState(null);
  const [dueAt, setDueAt] = useState(""), [minutesBefore, setMinutesBefore] = useState(15), [busy, setBusy] = useState(null);
  const run = async (key, operation) => {
    setBusy(key);
    try { await operation(); await refresh(); }
    catch (error) { onError(error.message); }
    finally { setBusy(null); }
  };
  const createTask = async (event) => {
    event.preventDefault();
    if (!title.trim()) return;
    await run("new", () => api("/tasks/", { method: "POST", body: JSON.stringify({ title: title.trim(), description: description.trim(), owner: "self", status: "todo" }) }));
    setTitle(""); setDescription("");
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
    await run(`schedule-${task.id}`, () => api(`/tasks/${task.id}/schedule/`, {
      method: "POST",
      body: JSON.stringify({ due_at: new Date(dueAt).toISOString(), minutes_before: Number(minutesBefore) }),
    }));
    setScheduleTask(null);
  };
  const beginTaskEdit = (task) => setEditingTask({ id: task.id, title: task.title, description: task.description || "", owner: task.owner, owner_name: task.owner_name || "" });
  const saveTask = async () => {
    if (!editingTask?.title.trim()) return;
    await run(`edit-${editingTask.id}`, () => api(`/tasks/${editingTask.id}/`, { method: "PATCH", body: JSON.stringify({
      title: editingTask.title.trim(), description: editingTask.description.trim(), owner: editingTask.owner,
      owner_name: editingTask.owner === "other" ? editingTask.owner_name.trim() : "",
    }) }));
    setEditingTask(null);
  };
  const deleteTask = async (task) => {
    if (!window.confirm(`Eliminar a tarefa “${task.title}”?`)) return;
    await run(`delete-${task.id}`, () => api(`/tasks/${task.id}/`, { method: "DELETE" }));
  };
  const visible = tasks.filter((task) => {
    if (filter === "all") return true;
    if (filter === "done") return task.status === "done";
    if (filter === "mine") return task.owner === "self" && !["done", "cancelled"].includes(task.status);
    if (filter === "others") return task.owner === "other" && !["done", "cancelled"].includes(task.status);
    return !["done", "cancelled"].includes(task.status);
  });
  return <>
    <form className="quick-task" onSubmit={createTask}><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Adicionar uma tarefa…"/><textarea rows={1} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Descrição (opcional)"/><button disabled={busy === "new"}>{busy === "new" && <Spinner/>}Adicionar</button></form>
    <div className="filters">{[["todo", "A fazer"], ["mine", "Minhas tarefas"], ["others", "Pendentes de outros intervenientes"], ["done", "Concluídas"], ["all", "Todas"]].map(([value, label]) => <button type="button" className={filter === value ? "active" : ""} onClick={() => setFilter(value)} key={value}>{label}</button>)}</div>
    <div className="card-list">
      {visible.length === 0 && <div className="empty">Não existem tarefas nesta vista.</div>}
      {visible.map((task) => {
        const overdue = task.status !== "done" && task.due_at && new Date(task.due_at).getTime() < Date.now();
        const reminderFired = task.status !== "done" && task.reminder_status === "notified";
        const alertClass = overdue ? "overdue" : reminderFired ? "reminder-fired" : "";
        const isEditing = editingTask?.id === task.id;
        return <article className={`card task ${alertClass}`} key={task.id}>
        {(overdue || reminderFired) && <span className="task-alert" title={overdue ? "Prazo ultrapassado" : "Lembrete emitido"}>!</span>}
        <button className={`check ${task.status === "done" ? "done" : ""}`} title={task.status === "done" ? "Reabrir tarefa" : "Concluir tarefa"} disabled={busy === `status-${task.id}`} onClick={() => run(`status-${task.id}`, () => api(`/tasks/${task.id}/${task.status === "done" ? "reopen" : "complete"}/`, { method: "POST" }))}>✓</button>
        <div className="task-body">
          <div className="task-card-header">{isEditing ? <input className="task-title-input" value={editingTask.title} onChange={(event) => setEditingTask({ ...editingTask, title: event.target.value })}/> : <h3>{task.title}</h3>}<div>{isEditing ? <><button className="text-button" onClick={saveTask} disabled={!editingTask.title.trim() || busy === `edit-${task.id}`}>{busy === `edit-${task.id}` && <Spinner/>}Concluir</button><button className="text-button secondary-text" onClick={() => setEditingTask(null)}>Cancelar</button></> : <><button className="text-button" onClick={() => beginTaskEdit(task)}>Editar</button><button className="text-button danger" onClick={() => deleteTask(task)} disabled={busy === `delete-${task.id}`}>{busy === `delete-${task.id}` && <Spinner/>}Eliminar</button></>}</div></div>
          {isEditing ? <textarea className="task-description-input" rows={1} value={editingTask.description} onChange={(event) => setEditingTask({ ...editingTask, description: event.target.value })} placeholder="Descrição (opcional)"/> : task.description && <p className="task-description">{task.description}</p>}
          <div className="task-meta">{isEditing ? <><select value={editingTask.owner} onChange={(event) => setEditingTask({ ...editingTask, owner: event.target.value })}><option value="self">Eu</option><option value="other">Outro interveniente</option><option value="unknown">Por definir</option></select>{editingTask.owner === "other" && <input value={editingTask.owner_name} onChange={(event) => setEditingTask({ ...editingTask, owner_name: event.target.value })} placeholder="Nome do responsável"/>}</> : <span>{task.owner === "self" ? "Eu" : task.owner_name || "Outro interveniente"}</span>}<span> · Criada a {new Date(task.created_at).toLocaleString()} {task.creation_source === "system" ? "pelo Sistema" : "por ti"}{task.due_at ? ` · Limite: ${new Date(task.due_at).toLocaleString()}` : ""}{task.reminder_at ? ` · Lembrete: ${new Date(task.reminder_at).toLocaleString()}` : ""}</span></div>
          <div className="task-actions"><button className="text-button" onClick={() => editSchedule(task)}>Definir data e lembrete</button>{task.due_is_ambiguous && <span className="warning">Data por confirmar</span>}</div>
          {scheduleTask === task.id && <div className="schedule-editor"><input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)}/><select value={minutesBefore} onChange={(event) => setMinutesBefore(event.target.value)}>{REMINDER_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><button onClick={() => saveSchedule(task)} disabled={!dueAt || busy === `schedule-${task.id}`}>{busy === `schedule-${task.id}` && <Spinner/>}Guardar</button><button className="secondary" onClick={() => setScheduleTask(null)}>Cancelar</button></div>}
        </div>
      </article>; })}
    </div>
  </>;
}

function ListeningLogs({ logs }) {
  return <div className="card-list logs-list">{logs.length === 0 ? <div className="empty">Não existem registos recentes da escuta ativa.</div> : logs.map((log) => <article className="card log-entry" key={log.id}><time>{new Date(log.recorded_at).toLocaleString()}</time><span>{log.language?.toUpperCase() || "Idioma desconhecido"}</span><p>{log.text}</p></article>)}</div>;
}

function SearchResults({ results, onOpenSegment }) {
  const items = [
    ...results.segments.map((item) => ({ id: `segment-${item.id}`, type: "Transcrição", title: item.speaker_label || "Interveniente", text: item.text, item })),
    ...results.notes.map((item) => ({ id: `note-${item.id}`, type: "Nota", title: item.title || "Nota pessoal", text: item.body })),
    ...results.tasks.map((item) => ({ id: `task-${item.id}`, type: "Tarefa", title: item.title, text: item.description })),
  ];
  if (items.length === 0) return <div className="empty">Não foram encontrados resultados locais.</div>;
  return <div className="card-list search-results">{items.map((result) => {
    const content = <><div className="search-result-meta"><span>{result.type}</span><span>{result.title}</span></div>{result.text && <p>{result.text}</p>}</>;
    return result.item ? <button className="card search-result" onClick={() => onOpenSegment(result.item)} key={result.id}>{content}</button> : <article className="card search-result" key={result.id}>{content}</article>;
  })}</div>;
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

function Meetings({ sessions, refresh, onError, target, onTargetHandled, onNotice }) {
  const [selected, setSelected] = useState(null);
  const [note, setNote] = useState("");
  const [title, setTitle] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingSpeaker, setEditingSpeaker] = useState(null);
  const [busy, setBusy] = useState("");
  const [editingTranscript, setEditingTranscript] = useState(null);
  const open = async (id) => {
    try { const meeting = await api(`/sessions/${id}/`); setSelected(meeting); setTitle(meeting.title); setEditingTitle(false); setEditingSpeaker(null); }
    catch (error) { onError(error.message); }
  };
  useEffect(() => {
    if (!target?.meetingId) return;
    open(target.meetingId).then(() => onTargetHandled?.());
  }, [target?.meetingId, target?.segmentId]);
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
  const retranscribe = () => window.confirm("Voltar a transcrever substituirá a transcrição e o resumo atuais. Continuar?") && run("retranscribe", () => api(`/sessions/${selected.id}/retranscribe/`, { method: "POST" }));
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
  const addNote = () => note.trim() && run("note", async () => { await api("/notes/", { method: "POST", body: JSON.stringify({ session: selected.id, body: note }) }); setNote(""); });
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
    <div className="meeting-meta"><div className="processing-actions"><ProcessingBadge processing={selected.processing} onRetry={retryProcessing} onCancel={cancelProcessing} retrying={busy === "retry"} cancelling={busy === "cancel"}/><button onClick={regenerateSummary} disabled={busy === "summary" || ["pending", "processing"].includes(selected.processing.state)}>{busy === "summary" && <Spinner/>}Voltar a gerar resumo</button><button onClick={retranscribe} disabled={busy === "retranscribe" || !selected.processing.retranscription_available}>{busy === "retranscribe" && <Spinner/>}Voltar a transcrever</button></div><label>Idioma <select value={selected.language || ""} onChange={(event) => setLanguage(event.target.value)} disabled={busy === "language"}><option value="" disabled>Deteção automática</option><option value="pt">Português</option><option value="en">English</option></select></label></div>
    {selected.summaries.length === 0 && <article className="card summary pending-summary">{!["failed", "cancelled"].includes(selected.processing.state) && <Spinner/>}<p>{selected.processing.state === "failed" ? "Não foi possível gerar o resumo. Usa Repetir para tentar novamente." : selected.processing.state === "cancelled" ? "O processamento desta reunião foi cancelado." : "O resumo aparecerá quando o processamento terminar."}</p></article>}
    {selected.summaries.map((summary) => <SummaryCard summary={summary} key={summary.id}/>)}
    {selected.speakers.length > 0 && <article className="card participants"><h3>Participantes</h3>{selected.speakers.map((speaker) => { const isEditing = editingSpeaker?.id === speaker.id; return <div className="participant-row" key={speaker.id}><div className="participant-field"><span>{speaker.kind === "self" ? "A minha voz" : "Participante"}</span>{isEditing ? <input value={editingSpeaker.label} onChange={(event) => setEditingSpeaker({ ...editingSpeaker, label: event.target.value })} autoFocus/> : <strong>{speaker.label}</strong>}</div><div className="participant-actions">{isEditing ? <><button className="text-button" onClick={() => saveSpeaker(speaker)} disabled={!editingSpeaker.label.trim() || busy === `speaker-${speaker.id}`}>Concluir</button><button className="text-button secondary-text" onClick={() => setEditingSpeaker(null)}>Cancelar</button></> : <button className="text-button" onClick={() => setEditingSpeaker({ id: speaker.id, label: speaker.label })}>Editar</button>}{speaker.kind !== "self" && speaker.label !== "Outros" && !isEditing && <button className="text-button" onClick={() => mergeSpeaker(speaker)} disabled={busy === `merge-${speaker.id}`}>{busy === `merge-${speaker.id}` && <Spinner/>}Fundir em Outros</button>}</div></div>; })}</article>}
    <article className="card notes"><h3>Notas pessoais</h3>{selected.notes.map((item) => <p key={item.id}>{item.body}</p>)}<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Adicionar uma nota…"/><button onClick={addNote} disabled={busy === "note"}>{busy === "note" && <Spinner/>}Guardar nota</button></article>
    <div className="transcript">{groupedSegments.map((group) => {
      const editing = editingTranscript === group.id;
      const highlighted = group.segments.some((segment) => target?.segmentId === segment.id);
      return <article className={`card ${highlighted ? "highlighted-segment" : ""}`} key={group.id}>
        {group.segments.map((segment) => <span id={`segment-${segment.id}`} className="segment-anchor" key={segment.id}/>) }
        <div className="transcript-heading"><div><time className="transcript-timestamp">{formatTranscriptTime(group.startMs)}</time><strong>{group.speakerLabel}</strong><small>{group.languages.map((language) => language.toUpperCase()).join(" / ")}</small></div><button className="text-button" onClick={() => setEditingTranscript(editing ? null : group.id)}>{editing ? "Concluir" : "Editar"}</button></div>
        {editing ? <div className="segment-editors">{group.segments.map((segment) => <textarea key={segment.id} defaultValue={segment.text} onBlur={(event) => event.target.value !== segment.text && run(`segment-${segment.id}`, () => api(`/segments/${segment.id}/`, { method: "PATCH", body: JSON.stringify({ text: event.target.value }) }))}/>)}</div> : <p className="transcript-text">{group.text}</p>}
      </article>;
    })}</div>
  </div>;
  return <div className="card-list">{sessions.map((session) => <button className="card meeting-card" onClick={() => open(session.id)} key={session.id}><div><h3>{session.title || "Reunião sem título"}</h3><p>{new Date(session.started_at).toLocaleString()} · {session.status} · {session.language?.toUpperCase() || "A detetar idioma"}</p></div><ProcessingBadge processing={session.processing}/></button>)}</div>;
}

function Settings({ microphoneId, setMicrophoneId, onError }) {
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
  return <article className="settings-grid card"><div><label>Modelo para resumos, tarefas e perguntas à IA</label><strong>{aiModel || "A carregar…"} · {ollamaAvailable ? "Disponível" : "Indisponível"}</strong></div><div><label>Modelo de transcrição</label><strong>Faster Whisper Medium · PT/EN</strong></div><div><label>Microfone</label><select value={microphoneId} onChange={(event) => setMicrophoneId(event.target.value)}><option value="">Predefinido do Windows</option>{devices.map((device) => <option value={device.deviceId} key={device.deviceId}>{device.label || "Microfone"}</option>)}</select></div><div><label>Idioma para reuniões curtas</label><select value={defaultLanguage} onChange={(event) => setDefaultLanguage(event.target.value)}><option value="pt">Português</option><option value="en">English</option></select></div><div className="settings-limits wide"><label>Retenção máxima (dias)<input type="number" min="1" max="7" value={retentionDays} onChange={(event) => setRetentionDays(event.target.value)}/></label><label>Limite de áudio (GB)<input type="number" min="1" value={maxGb} onChange={(event) => setMaxGb(event.target.value)}/></label><label>Janela dos logs (horas)<input type="number" min="1" value={logHours} onChange={(event) => setLogHours(event.target.value)}/></label></div><div className="wide"><label>Glossário de nomes, empresas e siglas</label><textarea value={glossary} onChange={(event) => setGlossary(event.target.value)} placeholder="Warpcom, SecureNet, onboarding, Oracle…"/></div><label className="toggle"><input type="checkbox" checked={launchAtLogin} onChange={(event) => setLaunchAtLogin(event.target.checked)}/> Iniciar com o Windows</label><button className="save" onClick={save} disabled={busy}>{busy && <Spinner/>}Guardar definições</button></article>;
}

export default function App() {
  const [view, setView] = useState("Hoje"), [tasks, setTasks] = useState([]), [sessions, setSessions] = useState([]), [summaries, setSummaries] = useState([]), [logs, setLogs] = useState([]), [meetingCapture, setMeetingCapture] = useState(null), [activeListening, setActiveListening] = useState(null), [activeEnabled, setActiveEnabled] = useState(() => localStorage.getItem("activeListeningEnabled") !== "false"), [error, setError] = useState(""), [query, setQuery] = useState(""), [results, setResults] = useState(null), [chatAnswer, setChatAnswer] = useState(null), [notice, setNotice] = useState(""), [asking, setAsking] = useState(false), [dailyJob, setDailyJob] = useState(null), [dailyDate, setDailyDate] = useState(localDateValue), [captureBusy, setCaptureBusy] = useState(false), [microphoneId, setMicrophoneId] = useState(() => localStorage.getItem("microphoneDeviceId") || ""), [meetingTarget, setMeetingTarget] = useState(null), [meetingsKey, setMeetingsKey] = useState(0);
  const activeController = useRef(null), activeStarting = useRef(false), meetingStarting = useRef(false), activeRequested = useRef(activeEnabled);
  const notificationState = useRef({ initialized: false, taskIds: new Set(), summaryIds: new Set() });
  const refresh = useCallback(async () => {
    try {
      const [nextTasks, nextSessions, nextSummaries, nextLogs] = await Promise.all([api("/tasks/"), api("/sessions/"), api("/summaries/"), api("/active-listening-logs/")]);
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
          await window.notetaker?.notify({ title: "Resumo disponível", body: meeting?.title || "O resumo da reunião está pronto." });
        }
        for (const task of newTasks) {
          await window.notetaker?.notify({ title: "Nova tarefa", body: task.title });
        }
      } else {
        tracked.initialized = true;
        tracked.summaryIds = nextSummaryIds;
        tracked.taskIds = nextTaskIds;
      }
      setTasks(nextTasks);
      setSessions(nextSessions);
      setSummaries(nextSummaries);
      setLogs(nextLogs);
    } catch (nextError) { setError(nextError.message); }
  }, []);  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { const timer = setInterval(refresh, 5000); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => { if (!notice) return undefined; const timer = setTimeout(() => setNotice(""), 30_000); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => { if (!dailyJob) return undefined; const check = async () => { try { const job = await api(`/jobs/${dailyJob.id}/`); if (job.status === "complete") { setDailyJob(null); setNotice(`Resumo de ${formatCalendarDate(dailyJob.date)} concluído.`); refresh(); } if (job.status === "failed") { setDailyJob(null); setError(job.error || "Não foi possível gerar o resumo diário."); } } catch (nextError) { setDailyJob(null); setError(nextError.message); } }; check(); const timer = setInterval(check, 2000); return () => clearInterval(timer); }, [dailyJob, refresh]);
  useEffect(() => { const check = async () => { try { const due = await api("/reminders/due/"); for (const reminder of due) { await window.notetaker?.notify({ title: "Lembrete", body: reminder.task_title }); await api(`/reminders/${reminder.id}/notified/`, { method: "POST" }); } } catch (nextError) { setError(nextError.message); } }; check(); const timer = setInterval(check, 30000); return () => clearInterval(timer); }, []);
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
    const trimmedQuery = query.trim();
    if (!trimmedQuery) { setResults(null); return undefined; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const nextResults = await api(`/search/?q=${encodeURIComponent(trimmedQuery)}`);
        if (!cancelled) setResults(nextResults);
      } catch (nextError) {
        if (!cancelled) setError(nextError.message);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);
  const ask = async () => { if (!query.trim()) return; setAsking(true); try { setChatAnswer(await api("/chat/", { method: "POST", body: JSON.stringify({ question: query.trim() }) })); } catch (nextError) { setError(nextError.message); } finally { setAsking(false); } };
  const openSource = (source) => { setMeetingTarget({ meetingId: source.meeting_id, segmentId: source.segment_id }); setView("Reuniões"); };
  const openSearchSegment = (segment) => { setMeetingTarget({ meetingId: segment.session, segmentId: segment.id }); setView("Reuniões"); };
  const selectView = (nextView) => {
    if (nextView === "Reuniões") {
      setMeetingTarget(null);
      setMeetingsKey((value) => value + 1);
    }
    setView(nextView);
  };
  const handleMeetingTarget = () => {
    const segmentId = meetingTarget?.segmentId;
    if (segmentId) requestAnimationFrame(() => document.getElementById(`segment-${segmentId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
    setMeetingTarget(null);
  };
  const generateDaily = async (date) => { try { const job = await api("/summaries/generate_daily/", { method: "POST", body: JSON.stringify({ date }) }); setDailyJob({ id: job.job_id, date: job.summary_date }); setNotice(`A processar as reuniões e tarefas de ${formatCalendarDate(job.summary_date)} localmente.`); } catch (nextError) { setError(nextError.message); } };
  const generateSelectedDaily = (event) => {
    event.preventDefault();
    if (!dailyDate) return;
    event.currentTarget.closest("details")?.removeAttribute("open");
    generateDaily(dailyDate);
  };
  const latestDaily = useMemo(() => summaries.find((item) => item.kind === "daily"), [summaries]);
  return <main className="shell"><aside><div className="brand"><span className="brand-mark">N</span><strong>My AI Notetaker</strong></div><nav>{VIEWS.map((item) => <button className={view === item ? "active" : ""} onClick={() => selectView(item)} key={item}>{item}</button>)}</nav><div className="privacy"><span className={activeListening || meetingCapture ? "live-dot" : "idle-dot"}/>{meetingCapture ? "Reunião em curso" : activeListening ? "Escuta ativa" : "Captura pausada"}</div></aside><section className="content"><header><div><p className="eyebrow">OFFLINE · PRIVADO</p><h1>{view}</h1></div><div className="header-actions"><div className="daily-summary-button"><button onClick={() => generateDaily(localDateValue())} disabled={Boolean(dailyJob)}>{dailyJob && <Spinner/>}Resumo do dia</button><details><summary aria-label="Escolher data do resumo">▾</summary><form onSubmit={generateSelectedDaily}><strong>Escolher outro dia</strong><input type="date" max={localDateValue()} value={dailyDate} onChange={(event) => setDailyDate(event.target.value)}/><button disabled={!dailyDate || Boolean(dailyJob)}>Gerar resumo</button></form></details></div><button className={`listening ${activeListening ? "active" : ""}`} onClick={toggleActiveListening} disabled={captureBusy || Boolean(meetingCapture)}>{activeEnabled ? "Desativar escuta" : "Ativar escuta"}</button><button className={`capture ${meetingCapture ? "active" : ""}`} onClick={toggleMeeting} disabled={captureBusy}>{captureBusy && <Spinner/>}{meetingCapture ? "Terminar reunião" : "Iniciar reunião"}</button></div></header>
    {error && <div className="error">{error}<button onClick={() => setError("")}>×</button></div>}{notice && <div className="notice">{notice}<button onClick={() => setNotice("")}>×</button></div>}
    {view === "Hoje" && latestDaily && <SummaryCard summary={latestDaily} title={latestDaily.summary_date ? `Resumo de ${formatCalendarDate(latestDaily.summary_date)}` : "Resumo mais recente"}/>} {(view === "Hoje" || view === "Tarefas") && <TaskList tasks={tasks} refresh={refresh} onError={setError}/>} {view === "Reuniões" && <Meetings key={meetingsKey} sessions={sessions} refresh={refresh} onError={setError} target={meetingTarget} onTargetHandled={handleMeetingTarget} onNotice={setNotice}/>} {view === "Pesquisa" && <><div className="search"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Pesquisar ou perguntar sobre as reuniões…"/><button type="button" onClick={ask} disabled={asking}>{asking && <Spinner/>}{asking ? "A pensar…" : "Pesquisa de IA"}</button></div>{chatAnswer && <article className="card answer"><h3>Resposta</h3><p>{chatAnswer.answer}</p>{chatAnswer.sources?.length ? <div className="answer-sources"><strong>Fontes</strong>{chatAnswer.sources.map((source) => <button key={source.segment_id || source.id} onClick={() => openSource(source)}><span>{source.meeting_title} · {source.speaker}</span><small>{source.text}</small></button>)}</div> : <small>Fontes: sem evidência suficiente</small>}</article>}{results && <SearchResults results={results} onOpenSegment={openSearchSegment}/>}</>} {view === "Definições" && <Settings microphoneId={microphoneId} setMicrophoneId={setMicrophoneId} onError={setError}/>} {view === "Logs" && <ListeningLogs logs={logs}/>}</section></main>;
}
