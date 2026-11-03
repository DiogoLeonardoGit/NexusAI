import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

// Share one availability result between the startup notice and Settings.
export function useAIAvailability() {
  const [health, setHealth] = useState(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const check = useCallback(async (signal) => {
    setChecking(true);
    setError("");
    try {
      const result = await api("/health/", { signal });
      if (typeof result.ai_available !== "boolean") throw new Error("Resposta de disponibilidade inválida.");
      setHealth(result);
      return result;
    } catch (nextError) {
      if (!signal?.aborted) setError(`Não foi possível verificar a IA: ${nextError.message}`);
      return null;
    } finally {
      if (!signal?.aborted) setChecking(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer;
    // The packaged backend may still be starting when the window opens.
    const attempt = async () => {
      const result = await check(controller.signal);
      if (!result && !controller.signal.aborted) timer = setTimeout(attempt, 5000);
    };
    attempt();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [check]);
  return { health, checking, error, check };
}

// Use a native modal for keyboard focus containment and Escape dismissal.
export default function AISetupGuide({ health, checking, error, check, open, onClose }) {
  const dialog = useRef(null);
  const available = health?.ai_available;
  const model = health?.model || "qwen2.5-14b-instruct";
  useEffect(() => {
    const element = dialog.current;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);
  return <dialog ref={dialog} className="ai-setup-dialog" aria-labelledby="ai-setup-title" onClose={onClose}>
    <h2 id="ai-setup-title">{available ? "Configurar a IA local" : "Funcionalidades de IA reduzidas"}</h2>
    {!available && <p>O modelo de IA configurado não está disponível. Os resumos, a extração automática de tarefas e as perguntas à IA ficam limitados enquanto não houver ligação ao modelo. A gravação e a transcrição continuam disponíveis.</p>}
    <p>O modelo pode estar em falta ou o servidor local pode estar desligado. Não é necessário voltar a instalar um modelo que já tenhas.</p>
    <ol>
      <li><strong>Instalar o LM Studio.</strong> Abre <code>https://lmstudio.ai/download</code> no navegador, descarrega a versão Windows e instala-a.</li>
      <li><strong>Descarregar um modelo de conversação.</strong> Uma opção recomendada é <code>Qwen2.5-14B-Instruct-GGUF</code> em <code>Q4_K_M</code>, sem Coder nem 1M. Também podes escolher outro modelo com suporte a JSON estruturado. O download inicial requer internet.</li>
      <li><strong>Carregar o modelo.</strong> Seleciona-o no LM Studio e configura o contexto para <strong>8192 tokens</strong> antes de o carregar. Se já estiver carregado, volta a carregá-lo para aplicar o contexto.</li>
      <li><strong>Iniciar o servidor.</strong> Na área Developer / Local Server, inicia o servidor em <code>http://127.0.0.1:1234</code>, sem autenticação. Não é necessário ativar CORS nem Serve on Local Network.</li>
      <li><strong>Selecionar o modelo.</strong> Em Definições, atualiza a lista de modelos de conversação, escolhe um modelo e guarda. O identificador atualmente configurado é <code>{model}</code>. A seleção não carrega nem descarrega modelos no LM Studio. Se necessário, carrega o modelo no LM Studio ou através do terminal:
        <pre><code>lms ls{"\n"}lms load &lt;chave-do-modelo&gt; --identifier {model} --context-length 8192</code></pre>
        Substitui <code>&lt;chave-do-modelo&gt;</code> pela chave apresentada por <code>lms ls</code>.
      </li>
      <li><strong>Verificar novamente.</strong> Mantém o LM Studio e o servidor em execução e usa o botão abaixo. Nas Definições, a verificação de compatibilidade JSON faz um pequeno pedido sintético ao modelo guardado, sem enviar dados das reuniões. A disponibilidade, por si só, não confirma compatibilidade. O primeiro pedido de IA pode demorar a carregar o modelo.</li>
    </ol>
    <p className="ai-setup-hint">Depois do download, a IA funciona localmente. Este guia continua acessível em Definições, junto ao modelo de IA.</p>
    <div role="status" aria-live="polite">{error || (checking ? "A verificar a disponibilidade…" : available ? "Modelo disponível. As funcionalidades de IA podem ser utilizadas." : "Modelo indisponível. Confirma o servidor e o identificador do modelo.")}</div>
    <div className="ai-setup-actions"><button type="button" disabled={checking} onClick={() => check()}>Verificar novamente</button><button type="button" autoFocus onClick={onClose}>{available ? "Fechar" : "Continuar com funcionalidades reduzidas"}</button></div>
  </dialog>;
}
