# My AI Notetaker

Assistente pessoal desktop para Windows. Captura microfone e áudio do sistema, transcreve português e inglês com Faster Whisper e usa o `gemma4:12b` local através do Ollama para criar resumos, tarefas e lembretes.

Áudio, transcrições e notas permanecem no computador. O frontend comunica apenas com o backend local, que escuta em `127.0.0.1`. A integração GitLab opcional consulta tarefas na instância empresarial através do backend; nesta fase, não envia alterações.

## Requisitos

- Windows 11
- Python 3.12
- Node.js 24 e npm
- Ollama em execução com `gemma4:12b`

## Preparação

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe scripts\download_models.py
npm install --prefix frontend
```

O download do Whisper acontece apenas durante a preparação. A utilização normal não precisa de internet.

## Desenvolvimento

Inicia o Ollama numa consola:

```powershell
ollama serve
```

Depois inicia a aplicação:

```powershell
cd frontend
npm run dev
```

A janela pode ser minimizada para a área de notificação. A escuta ativa usa apenas o microfone e retoma automaticamente após uma reunião. O botão `Iniciar reunião` ativa simultaneamente o microfone selecionado e o loopback do áudio do Windows.

## Dados locais

Em desenvolvimento, a base SQLite e o áudio ficam em `data/`. Na aplicação instalada ficam na pasta de dados da aplicação do Windows. Na primeira execução, o Electron copia uma base inicial vazia e já preparada; nunca copia dados pessoais do workspace.

- O áudio já processado é removido ao fim de no máximo sete dias.
- O limite inicial de armazenamento é 5 GB e pode ser reduzido nas definições.
- Transcrições, notas, resumos e tarefas não são removidos com o áudio.

## Validação

```powershell
.\.venv\Scripts\python.exe backend\manage.py check
.\.venv\Scripts\python.exe backend\manage.py test notetaker.tests
npm test --prefix frontend
npm run build --prefix frontend
```

## Empacotamento Windows

```powershell
cd backend
..\.venv\Scripts\pyinstaller.exe --noconfirm notetaker-backend.spec
cd ..\frontend
npm run electron:dist
```

O backend é empacotado como pasta para evitar o atraso de extração de executáveis PyInstaller `one-file`.

## Limitações conhecidas

- A identificação robusta é `Eu` para o microfone e `Outros` para o áudio do sistema. Separar automaticamente cada participante remoto não é fiável em todas as chamadas.
- O primeiro pedido ao `gemma4:12b` pode demorar alguns minutos enquanto o Ollama carrega o modelo.
- A aplicação só consegue captar áudio que o Windows e a aplicação de origem permitam disponibilizar por loopback.

## Projetos, etiquetas e trabalho diário

A vista Projetos permite criar e editar projetos e etiquetas e reúne reuniões, decisões,
notas e tarefas. Os conteúdos têm controlos para atribuir projetos e etiquetas.
Acede a Projetos no menu lateral. A criação seleciona imediatamente o projeto e mostra
uma confirmação; a edição usa formulários da aplicação. Os seletores usam menus próprios
com navegação por setas, Enter para escolher e Escape para fechar.
Novas tarefas extraídas herdam a organização atual da reunião; alterações manuais posteriores
são preservadas. Notas e tarefas sem projeto próprio também aparecem através do projeto da
reunião de origem. Uma atribuição explícita a outro projeto prevalece.

Em Tarefas, o botão `+`, alinhado com os filtros, abre a criação inline. O formulário
fecha após guardar ou cancelar. Projetos e Hoje conservam os seus formulários atuais.
As prioridades antigas são convertidas em etiquetas P1/P2/P3; novas tarefas não têm
um campo separado de prioridade. Os separadores antigos tornam-se vistas de etiquetas,
mantendo as associações e o estado recolhido. Uma tarefa pode aparecer em várias vistas.
Em `Gerir vistas por etiqueta`, escolhe uma etiqueta existente ou cria uma nova.
Remover uma vista preserva a etiqueta e as tarefas. O nome é gerido no catálogo de etiquetas.
Lista e Quadro usam os filtros existentes. Arrastar entre colunas troca apenas a etiqueta
da origem e do destino, preservando outras etiquetas. A coluna Concluídas fecha a tarefa;
arrastar daí para uma coluna de etiqueta reabre-a. Os filtros continuam a limitar o quadro,
incluindo a coluna Concluídas. Pesquisa e ordenação mantêm o comportamento existente.

Hoje agrupa tarefas pendentes em atrasadas, hoje, próximos sete dias e sem prazo, usando
a data local do computador. Tarefas posteriores continuam disponíveis em Tarefas.
A evidência de uma tarefa abre o trecho da transcrição. O clique numa notificação do Windows
restaura e foca a janela, abrindo a tarefa ou reunião; destinos indisponíveis apresentam um erro.

A pesquisa tem filtros por projeto, etiqueta, data da reunião e participante, ignora acentos
e inclui reuniões, transcrições, resumos, notas e tarefas, com fontes clicáveis.
A pesquisa de IA expande vocabulário e avalia a relevância através do Ollama existente.
Este processamento acrescenta tempo de resposta e não utiliza um índice de embeddings.
Os limites de candidatos são aplicados após a ordenação textual. Se a expansão ou avaliação
falhar, a pesquisa textual continua disponível. As respostas recebem contexto limitado e
apenas aceitam referências aos registos incluídos. Conteúdos sem reunião usam a data de criação.
O filtro de participante usa a reunião associada; nas transcrições usa o autor do trecho.

Projetos e etiquetas exigem uma migration, com autorizações separadas para criar e aplicar,
conforme o AGENTS.md. O empacotamento também requer uma base inicial vazia com o schema
atualizado; não distribuir uma base com dados pessoais.

## Integração GitLab — fase de consulta

A ligação está limitada a `https://gitlab.warpcom.com` e ao projeto
`serviceunit/django-apps/twinportal`. É necessário acesso VPN e um token pessoal com
scope `api` da conta `diogo.leonardo@warpcom.com`, com acesso ao projeto.
Introduz o token em Definições > GitLab na aplicação desktop. O Electron guarda-o
encriptado pelo Windows (`safeStorage`) na pasta de dados da aplicação. O backend
recebe-o apenas em memória; não é devolvido pela API nem guardado na SQLite.
O modo de desenvolvimento só em browser não persiste credenciais.

A sincronização está **desativada por defeito**. Ativar permite exclusivamente consultas
e importação nesta fase. Desativar impede novos pedidos, incluindo novas páginas de uma
consulta em curso; um pedido HTTP já enviado pode terminar. O controlo está em Definições
e na aba Tarefas. Há sincronização ao iniciar o backend, a cada 60 segundos e no botão
Sincronizar agora, enquanto a aplicação estiver em execução, mesmo minimizada.

A identidade é confirmada pelo email de `/user` e a seleção usa o ID do responsável.
Só são importadas tarefas abertas atribuídas a essa conta; mencionar o nome ou ser autor
não basta. Tarefas já importadas são reconciliadas também quando fechadas ou reabertas.
Tarefas que deixem de estar atribuídas a ti são retiradas das vistas ativas e suspendem
alterações. Os registos locais são preservados. `Ocultar nesta app` conserva a identidade
externa e evita reimportação; não elimina nem fecha tarefas no GitLab.

As tarefas importadas mostram o ícone GitLab, que abre a origem no browser. As locais
continuam locais. Projetos e ligações a reuniões permanecem independentes do projeto GitLab.
Etiquetas remotas mantêm referências por projeto/ID e só podem ser escolhidas no projeto
de origem. Renomear etiquetas importadas é feito no GitLab; retirar uma etiqueta de uma
tarefa é permitido localmente e fica pendente.

Concluir/reabrir, editar título/descrição e alterar etiquetas atualiza a app e guarda
alterações pendentes. **Nenhuma dessas alterações é enviada nesta fase**, mesmo com a
sincronização ativa. A barreira `REMOTE_WRITES_ALLOWED = False`, no cliente GitLab,
bloqueia todos os métodos remotos de escrita antes do transporte. A lógica de emissão
de deltas está implementada e validada com respostas simuladas; ativar escritas exigirá
uma autorização futura e uma alteração deliberada dessa barreira.

O sincronismo compara a última versão remota com as alterações locais. Campos independentes
e alterações de etiquetas são conciliados; conflitos de título, descrição ou estado ficam
visíveis até escolher Manter alterações locais ou Usar versão GitLab. Sem rede, as alterações
continuam pendentes. Definições mostra última sincronização, pendentes, conflitos e erros.
Datas e horas de lembretes permanecem locais; a data limite remota é usada inicialmente
quando não existe data local. Não são sincronizados comentários, participantes ou reuniões.

A migration `0011_label_views_gitlab` converte prioridades e separadores antes de remover
os campos antigos, acrescenta as tabelas da integração e mantém projetos/reuniões/notas.
Foi aplicada à base local com uma cópia SQLite consistente em `data/backups/`.
Também foi atualizada a base vazia `backend/template/notetaker.sqlite3` usada pelo
instalador, sem copiar tarefas, reuniões, projetos, credenciais ou dados pessoais.
Os testes de sincronismo simulam o GitLab e não fazem pedidos à instância real.
