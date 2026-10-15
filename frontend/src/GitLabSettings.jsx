import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

export function GitLabIcon() {
  return <svg className="gitlab-icon" viewBox="0 0 24 24" role="img" aria-label="Origem GitLab"><path fill="#e24329" d="m12 22 4.4-13H7.6z"/><path fill="#fc6d26" d="M12 22 2 9h5.6zm0 0L22 9h-5.6z"/><path fill="#fca326" d="M2 9 4.2 2 7.6 9zm20 0L19.8 2 16.4 9zM2 9l-1 4 11 9zm20 0 1 4-11 9z"/></svg>;
}

export function LocalToGitLabIcon() {
  return <span className="local-to-gitlab-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 4h18v12H3zM8 20h8M12 16v4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/></svg><svg viewBox="0 0 24 24"><path d="M3 12h17m-6-6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg><GitLabIcon/></span>;
}

export default function GitLabSettings({ onError, refresh }) {
  const [config, setConfig] = useState(null), [busy, setBusy] = useState(false);
  const load = useCallback(async () => setConfig(await api("/gitlab/")), []);
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
  if (!config) return <article className="card gitlab-settings">A carregar integração GitLab…</article>;
  const projectName = config.project_path.split("/").at(-1);
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

    <dl className="gitlab-sync-stats" aria-label="Resumo da sincronização">
      {[["pending", "Pendentes"], ["conflicts", "Conflitos"], ["hidden", "Ocultas"], ["inactive", "Sem atribuição / acesso"]].map(([key, label]) => <div key={key} className={config[key] > 0 ? `has-items stat-${key}` : ""}><dt>{label}</dt><dd>{config[key] ?? 0}</dd></div>)}
    </dl>
    {config.error && <div role="alert" className="gitlab-settings-error"><strong>Não foi possível sincronizar</strong><p>{config.error}</p></div>}

    <label className="gitlab-write-toggle"><input type="checkbox" checked={!config.read_only} disabled={busy} onChange={(event) => { run(() => api("/gitlab/", { method: "PATCH", body: JSON.stringify({ write_enabled: event.target.checked }) })); }}/><span>Permitir escrita no GitLab<small>As alterações e os tempos são enviados automaticamente. Publicar tarefas locais continua a exigir o botão da tarefa.</small></span></label>
    <div className="gitlab-settings-footer">
      <div className="gitlab-sync-explanation"><strong>{config.read_only ? "Apenas consulta e importação" : "Envio automático ativo"}</strong><p>{config.read_only ? "Escritas remotas bloqueadas. As alterações locais ficam pendentes até ativares a escrita." : "Título, descrição, estado, etiquetas, estimativas e tempos são enviados a cada sincronização. Tarefas com conflitos ficam pendentes."}</p><small>{config.enabled ? "Consulta automaticamente com a app em execução, incluindo minimizada." : "Enquanto desativada, não são feitos pedidos ao GitLab."}</small></div>
      <div className="gitlab-sync-actions"><button type="button" className="secondary-action" disabled={busy || (!config.enabled && !config.has_token)} onClick={() => run(() => api("/gitlab/", { method: "PATCH", body: JSON.stringify({ enabled: !config.enabled }) }))}>{config.enabled ? "Desativar sincronização" : "Ativar sincronização"}</button>

        <button type="button" className="secondary-action" disabled={busy || !config.enabled || !config.has_token} onClick={() => run(() => api("/gitlab/sync/", { method: "POST" }))}>Forçar sincronização</button></div>
    </div>
  </article>;
}
