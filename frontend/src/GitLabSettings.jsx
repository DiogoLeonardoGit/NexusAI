import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

export function GitLabIcon() {
  return <svg className="gitlab-icon" viewBox="0 0 24 24" role="img" aria-label="Origem GitLab"><path fill="#e24329" d="m12 22 4.4-13H7.6z"/><path fill="#fc6d26" d="M12 22 2 9h5.6zm0 0L22 9h-5.6z"/><path fill="#fca326" d="M2 9 4.2 2 7.6 9zm20 0L19.8 2 16.4 9zM2 9l-1 4 11 9zm20 0 1 4-11 9z"/></svg>;
}

export function LocalToGitLabIcon() {
  return <span className="local-to-gitlab-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 4h18v12H3zM8 20h8M12 16v4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/></svg><svg viewBox="0 0 24 24"><path d="M3 12h17m-6-6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg><GitLabIcon/></span>;
}

export default function GitLabSettings({ onError, refresh }) {
  const [config, setConfig] = useState(null), [token, setToken] = useState(""), [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
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
      <div className="gitlab-settings-badges"><span className={`gitlab-connection-badge ${config.enabled ? "is-enabled" : ""}`}><i aria-hidden="true"/>{config.enabled ? "Sincronização ativa" : "Sincronização desativada"}</span><span className="gitlab-mode-badge">{config.read_only ? "Só leitura" : "Escrita manual"}</span></div>
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

    <section className="gitlab-credentials" aria-label="Credenciais GitLab">
      <div className="gitlab-credentials-heading"><h3>Ligação à conta</h3><span className={`gitlab-token-state ${config.has_token ? "is-configured" : ""}`}>{config.has_token ? "Token configurado" : "Token por configurar"}</span></div>
      <p>Usa um token pessoal com permissão <code>api</code>. Guardado com proteção do Windows.</p>
      <form className="gitlab-token-form" onSubmit={(event) => { event.preventDefault(); run(async () => {
      if (!window.notetaker?.saveGitLabToken) throw new Error("Usa a aplicação desktop para guardar o token protegido pelo Windows.");
      await window.notetaker.saveGitLabToken(token); setToken("");
    }); }}><label>Token pessoal<input type="password" autoComplete="new-password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={config.has_token ? "Introduz um novo token para substituir" : "Introduz o token da tua conta"}/></label>
      <button className="primary-action" disabled={busy || !token.trim()}>Guardar token</button>
      {config.has_token && <button type="button" className="secondary-action" disabled={busy} onClick={() => run(async () => {
        await api("/gitlab/", { method: "PATCH", body: JSON.stringify({ enabled: false }) });
        if (!window.notetaker?.saveGitLabToken) throw new Error("Usa a aplicação desktop para remover a credencial.");
        await window.notetaker.saveGitLabToken(""); setToken("");
      })}>Remover token</button>}
    </form>
    </section>

    <label className="gitlab-write-toggle"><input type="checkbox" checked={!config.read_only} disabled={busy} onChange={(event) => { setResult(""); run(() => api("/gitlab/", { method: "PATCH", body: JSON.stringify({ write_enabled: event.target.checked }) })); }}/><span>Permitir escrita no GitLab<small>As alterações só são enviadas ao clicar em “Enviar alterações pendentes”.</small></span></label>
    {result && <p className="project-success" role="status">{result}</p>}
    <div className="gitlab-settings-footer">
      <div className="gitlab-sync-explanation"><strong>{config.read_only ? "Apenas consulta e importação" : "Envio manual ativo"}</strong><p>{config.read_only ? "Escritas remotas bloqueadas. As alterações locais ficam pendentes até ativares a escrita e enviares." : "Título, descrição, estado e etiquetas são enviados apenas pelo botão. Tarefas com conflitos ficam pendentes."}</p><small>{config.enabled ? "Consulta automaticamente com a app em execução, incluindo minimizada." : "Enquanto desativada, não são feitos pedidos ao GitLab."}</small></div>
      <div className="gitlab-sync-actions"><button type="button" className="secondary-action" disabled={busy || (!config.enabled && !config.has_token)} onClick={() => run(() => api("/gitlab/", { method: "PATCH", body: JSON.stringify({ enabled: !config.enabled }) }))}>{config.enabled ? "Desativar sincronização" : "Ativar sincronização"}</button>

        <button type="button" className="primary-action" disabled={busy || config.read_only || !config.enabled || !config.has_token || !config.pending} onClick={() => { setResult(""); run(async () => {
          const response = await api("/gitlab/push/", { method: "POST" });
          setResult(response.busy ? "Já existe uma sincronização em curso. Tenta novamente." : response.disabled ? "A sincronização está desativada." : `${response.sent} tarefa(s) enviadas · ${response.time_entries_sent ?? 0} registos de tempo · ${response.failed} falhas · ${response.pending} pendentes · ${response.conflicts} conflitos`);
        }); }}>{busy ? "A processar…" : "Enviar alterações pendentes"}</button>
        <button type="button" className="secondary-action" disabled={busy || !config.enabled || !config.has_token} onClick={() => run(() => api("/gitlab/sync/", { method: "POST" }))}>Sincronizar agora</button></div>
    </div>
  </article>;
}
