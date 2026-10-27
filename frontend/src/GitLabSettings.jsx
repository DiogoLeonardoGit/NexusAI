import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api } from "./api";

const STATUS_CATEGORIES = [["pending", "Pendentes"], ["conflicts", "Conflitos"], ["hidden", "Ocultas"], ["inactive", "Sem atribuição / acesso"]];
const FIELD_LABELS = { title: "Título", description: "Descrição", state: "Estado", labels: "Etiquetas", due_date: "Prazo", milestone_id: "Milestone", estimate_seconds: "Estimativa", start_date: "Data de início" };

// Keep time entries separate because an uncertain delivery must not be retried blindly.
function timeEntryDescription(entry) {
  const hours = Math.floor(entry.duration_seconds / 3600);
  const minutes = Math.floor(entry.duration_seconds % 3600 / 60);
  const seconds = entry.duration_seconds % 60;
  const duration = [hours && `${hours} h`, minutes && `${minutes} min`, seconds && `${seconds} s`].filter(Boolean).join(" ") || "0 min";
  return `${duration} · ${entry.sync_state === "pending" ? "Por enviar" : "Envio por confirmar"}`;
}

export function GitLabIcon() {
  return <svg className="gitlab-icon" viewBox="0 0 24 24" role="img" aria-label="Origem GitLab"><path fill="#e24329" d="m12 22 4.4-13H7.6z"/><path fill="#fc6d26" d="M12 22 2 9h5.6zm0 0L22 9h-5.6z"/><path fill="#fca326" d="M2 9 4.2 2 7.6 9zm20 0L19.8 2 16.4 9zM2 9l-1 4 11 9zm20 0 1 4-11 9z"/></svg>;
}

export function LocalToGitLabIcon() {
  return <span className="local-to-gitlab-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 4h18v12H3zM8 20h8M12 16v4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/></svg><svg viewBox="0 0 24 24"><path d="M3 12h17m-6-6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg><GitLabIcon/></span>;
}

export default function GitLabSettings({ onError, refresh }) {
  const [config, setConfig] = useState(null), [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [category, setCategory] = useState(null), [detailsRetry, setDetailsRetry] = useState(0);
  const [details, setDetails] = useState({ category: null, loading: false, results: [], error: "" });
  const panelId = useId(), statButtons = useRef({});
  // Refresh the open category alongside the counters; cancel stale requests on switches.
  useEffect(() => {
    if (!category || !config) return;
    const controller = new AbortController();
    let cancelled = false;
    setDetails((previous) => ({ category, loading: true, error: "", results: previous.category === category ? previous.results : [] }));
    api(`/gitlab/tasks/?category=${category}`, { signal: controller.signal }).then((result) => {
      if (!cancelled) setDetails({ category, loading: false, results: result.results, error: "" });
    }).catch((error) => {
      if (!cancelled) setDetails({ category, loading: false, results: [], error: error.message });
    });
    return () => { cancelled = true; controller.abort(); };
  }, [category, config, detailsRetry]);
  const closeDetails = () => { setCategory(null); statButtons.current[category]?.focus(); };
  const openIssue = async (url) => {
    try {
      if (window.notetaker?.openGitLab) await window.notetaker.openGitLab(url);
      else window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) { onError(error.message); }
  };
  // Keep a failed request distinct from the initial loading state.
  const load = useCallback(async () => {
    try {
      setConfig(await api("/gitlab/"));
      setLoadError("");
    } catch (error) {
      setLoadError(error.message);
      throw error;
    }
  }, []);
  useEffect(() => {
    load().catch((error) => onError(error.message));
    const timer = setInterval(() => load().catch((error) => onError(error.message)), 10000);
    return () => clearInterval(timer);
  }, [load, onError]);
  const run = async (operation) => {
    if (busy) return;
    setBusy(true);
    try { await operation(); await load(); await refresh(); }
    catch (error) { onError(error.message); }
    finally { setBusy(false); }
  };
  // Retry only the failed read; leave synchronization and remote writes untouched.
  const retryLoad = async () => {
    if (busy) return;
    setBusy(true);
    try { await load(); }
    catch (error) { onError(error.message); }
    finally { setBusy(false); }
  };
  if (!config) return <article className="card gitlab-settings">{loadError ? <><p role="alert">Não foi possível carregar a integração GitLab: {loadError}</p><button type="button" disabled={busy} onClick={retryLoad}>Tentar novamente</button></> : "A carregar integração GitLab…"}</article>;
  const projectName = config.project_path.split("/").at(-1);
  const listing = details.category === category ? details : { loading: true, results: [], error: "" };
  return <article className="card gitlab-settings" aria-busy={busy}>
    <div className="gitlab-settings-heading">
      <div className="gitlab-settings-brand"><div><h2>GitLab</h2><p>As tuas tarefas, ligadas ao teu projeto.</p></div><span className="gitlab-brand-icon"><GitLabIcon/></span></div>
      <div className="gitlab-settings-badges"><span className={`gitlab-connection-badge ${config.enabled ? "is-enabled" : ""}`}><i aria-hidden="true"/>{config.enabled ? "Sincronização ativa" : "Sincronização desativada"}</span><span className="gitlab-mode-badge">{config.read_only ? "Só leitura" : "Escrita automática"}</span></div>
    </div>

    <dl className="gitlab-connection-details">
      <div><dt>Projeto</dt><dd><strong>{projectName}</strong><span>{config.base_url.replace(/^https?:\/\//, "")}/{config.project_path}</span></dd></div>
      <div><dt>Conta</dt><dd><strong>{config.username || "diogo.leonardo@warpcom.com"}</strong><span>Apenas tarefas atribuídas a ti</span></dd></div>
      <div><dt>Última sincronização</dt><dd><strong>{config.last_sync_at ? new Date(config.last_sync_at).toLocaleString() : "Ainda não realizada"}</strong><span>{config.enabled ? "Atualização a cada 60 segundos" : "Ativa a ligação para importar tarefas"}</span></dd></div>
    </dl>

    <div className="gitlab-sync-stats" role="group" aria-label="Resumo da sincronização">
      {STATUS_CATEGORIES.map(([key, label]) => <button type="button" key={key} ref={(element) => { statButtons.current[key] = element; }} className={config[key] > 0 ? `has-items stat-${key}` : ""} aria-expanded={category === key} aria-controls={panelId} onClick={() => setCategory(category === key ? null : key)}><strong>{config[key] ?? 0}</strong><span>{label}</span></button>)}
    </div>
    {category && <section className="gitlab-status-list" id={panelId} aria-labelledby={`${panelId}-title`} aria-busy={listing.loading} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); closeDetails(); } }}>
      <div className="gitlab-status-list-heading"><h3 id={`${panelId}-title`}>{STATUS_CATEGORIES.find(([key]) => key === category)[1]}</h3><button type="button" className="text-button" onClick={closeDetails}>Fechar lista</button></div>
      {listing.loading && <p role="status">A atualizar a lista…</p>}
      {listing.error ? <div role="alert"><p>Não foi possível carregar as tarefas: {listing.error}</p><button type="button" className="secondary-action" onClick={() => setDetailsRetry((value) => value + 1)}>Tentar novamente</button></div> : <>
        {!listing.loading && !listing.results.length && <p className="empty">Não existem tarefas nesta categoria.</p>}
        {!!listing.results.length && <ul>{listing.results.map((item) => <li key={item.task_id}>
          <div className="gitlab-status-task-heading"><strong>#{item.issue_iid} · {item.title || "Tarefa sem título"}</strong><button type="button" className="text-button" onClick={() => openIssue(item.web_url)}>Abrir no GitLab</button></div>
          {item.pending_fields.length > 0 && <p>Alterações por enviar: {item.pending_fields.map((field) => FIELD_LABELS[field] || field).join(", ")}.</p>}
          {item.conflict_fields.length > 0 && <p>Campos em conflito: {item.conflict_fields.map((field) => FIELD_LABELS[field] || field).join(", ")}.</p>}
          {item.time_entries.map((entry, index) => <p key={index}>Tempo: {timeEntryDescription(entry)}{entry.error && <span className="gitlab-status-task-error"> · {entry.error}</span>}</p>)}
          {(item.hidden || !item.active) && <p>{[item.hidden && "Oculta nesta app", !item.active && "Sem atribuição / acesso"].filter(Boolean).join(" · ")}</p>}
          {item.hidden && <><button type="button" className="secondary-action" disabled={busy || listing.loading} onClick={() => run(() => api(`/tasks/${item.task_id}/unhide/`, { method: "POST" }))}>Voltar a mostrar</button>{!item.active && <p>A tarefa só volta às listas normais quando tiveres novamente atribuição e acesso.</p>}</>}
          {item.error && <p className="gitlab-status-task-error">{item.error}</p>}
        </li>)}</ul>}
      </>}
    </section>}
    {config.error && <div role="alert" className="gitlab-settings-error"><strong>Não foi possível sincronizar</strong><p>{config.error}</p></div>}

    <label className="gitlab-write-toggle"><input type="checkbox" checked={!config.read_only} disabled={busy} onChange={(event) => { run(() => api("/gitlab/", { method: "PATCH", body: JSON.stringify({ write_enabled: event.target.checked }) })); }}/><span>Permitir escrita no GitLab<small>As alterações e os tempos são enviados automaticamente. Publicar tarefas locais continua a exigir o botão da tarefa.</small></span></label>
    <div className="gitlab-settings-footer">
      <div className="gitlab-sync-explanation"><strong>{config.read_only ? "Apenas consulta e importação" : "Envio automático ativo"}</strong><p>{config.read_only ? "Escritas remotas bloqueadas. As alterações locais ficam pendentes até ativares a escrita." : "Título, descrição, estado, etiquetas, estimativas e tempos são enviados a cada sincronização. Tarefas com conflitos ficam pendentes."}</p><small>{config.enabled ? "Consulta automaticamente com a app em execução, incluindo minimizada." : "Enquanto desativada, não são feitos pedidos ao GitLab."}</small></div>
      <div className="gitlab-sync-actions"><button type="button" className="secondary-action" disabled={busy || (!config.enabled && !config.has_token)} onClick={() => run(() => api("/gitlab/", { method: "PATCH", body: JSON.stringify({ enabled: !config.enabled }) }))}>{config.enabled ? "Desativar sincronização" : "Ativar sincronização"}</button>

        <button type="button" className="secondary-action" disabled={busy || !config.enabled || !config.has_token} onClick={() => run(() => api("/gitlab/sync/", { method: "POST" }))}>Forçar sincronização</button></div>
    </div>
  </article>;
}
