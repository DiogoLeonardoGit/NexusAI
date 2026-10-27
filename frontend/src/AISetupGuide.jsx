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
    {health?.provider === "ollama" && <p>Esta instalação usa Ollama, com o modelo <code>{model}</code>. Confirma que o Ollama está em execução e que esse modelo está instalado. O guia abaixo destina-se à configuração com LM Studio; para mudar de fornecedor, é necessário configurar a app para LM Studio e reiniciá-la.</p>}
    <ol>
      <li><strong>Instalar o LM Studio.</strong> Abre <code>https://lmstudio.ai/download</code> no navegador, descarrega a versão Windows e instala-a.</li>
      <li><strong>Descarregar o modelo.</strong> Na pesquisa de modelos do LM Studio, procura <code>Qwen2.5-14B-Instruct-GGUF</code> e escolhe a variante <code>Q4_K_M</code>, sem Coder nem 1M. O download inicial requer internet.</li>
      <li><strong>Carregar o modelo.</strong> Seleciona-o no LM Studio e configura o contexto para <strong>8192 tokens</strong> antes de o carregar. Se já estiver carregado, volta a carregá-lo para aplicar o contexto.</li>
      <li><strong>Iniciar o servidor.</strong> Na área Developer / Local Server, inicia o servidor em <code>http://127.0.0.1:1234</code>, sem autenticação. Não é necessário ativar CORS nem Serve on Local Network.</li>
      <li><strong>Confirmar o identificador.</strong> A app espera <code>{model}</code>{health?.provider === "ollama" ? " no fornecedor atual" : " no LM Studio"}. Para a configuração predefinida do LM Studio, o identificador deve ser <code>qwen2.5-14b-instruct</code>. Confirma o identificador em <code>http://127.0.0.1:1234/v1/models</code>. Se necessário, usa o terminal do LM Studio para carregar o modelo com um identificador explícito:
        <pre><code>lms ls{"\n"}lms load &lt;chave-do-modelo&gt; --identifier qwen2.5-14b-instruct --context-length 8192</code></pre>
        Substitui <code>&lt;chave-do-modelo&gt;</code> pela chave apresentada por <code>lms ls</code>. Se esta app usar outro identificador, usa esse valor em <code>--identifier</code>.
      </li>
      <li><strong>Verificar novamente.</strong> Mantém o LM Studio e o servidor em execução e usa o botão abaixo. O primeiro pedido de IA pode demorar a carregar o modelo.</li>
    </ol>
    <p className="ai-setup-hint">Depois do download, a IA funciona localmente. Este guia continua acessível em Definições, junto ao modelo de IA.</p>
    <div role="status" aria-live="polite">{error || (checking ? "A verificar a disponibilidade…" : available ? "Modelo disponível. As funcionalidades de IA podem ser utilizadas." : "Modelo indisponível. Confirma o servidor e o identificador do modelo.")}</div>
    <div className="ai-setup-actions"><button type="button" disabled={checking} onClick={() => check()}>Verificar novamente</button><button type="button" autoFocus onClick={onClose}>{available ? "Fechar" : "Continuar com funcionalidades reduzidas"}</button></div>
  </dialog>;
}
