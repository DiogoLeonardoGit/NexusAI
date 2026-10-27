# Nexus AI

Na interface, na janela e na bandeja, a aplicação apresenta-se como **Nexus**;
o instalador usa **Nexus AI**. O símbolo e as cores de destaque vêm da pasta `media/`; os fundos mantêm os tons escuros originais.
Para regenerar os ícones Windows a partir do símbolo fornecido, executa
`powershell -File scripts/generate_icon.ps1` antes de empacotar.

A barra de perguntas à IA mantém a resposta visível até clicares em
**Fechar resposta**, mesmo ao abrir uma fonte ou mudar de página. Abrir uma tarefa
citada desloca a página uma única vez; as atualizações automáticas permitem
continuar a fazer scroll livremente. Uma nova pergunta substitui a resposta anterior.

Assistente pessoal desktop para Windows. Captura microfone e áudio do sistema, transcreve português e inglês com Faster Whisper e usa um modelo local através do LM Studio (por defeito, `qwen2.5-14b-instruct`) ou do Ollama para criar resumos, tarefas e lembretes.

Áudio, transcrições e notas permanecem no computador. O frontend comunica apenas com o backend local, que escuta em `127.0.0.1`. A integração GitLab opcional consulta tarefas na instância empresarial através do backend e permite enviar alterações manualmente, após ativar o modo de escrita.

## Requisitos

- Windows 11
- Python 3.12
- Node.js 24 e npm
- LM Studio com `Qwen2.5-14B-Instruct-GGUF` em Q4_K_M, ou Ollama com `gemma4:12b`

## Preparação

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe scripts\download_models.py
npm install --prefix frontend
```

O download do Whisper acontece apenas durante a preparação. A utilização normal não precisa de internet.

## Desenvolvimento

No LM Studio, carrega `Qwen2.5-14B-Instruct` (sem `Coder` nem `1M`) com contexto de
8192 tokens e inicia o servidor em **Model Server / Developer → Local Server**.
O endereço predefinido é `http://127.0.0.1:1234`, sem autenticação. O backend usa
`/v1/chat/completions` com JSON Schema e valida também o conteúdo devolvido.
Não é necessário ativar CORS nem **Serve on Local Network**, porque o backend faz
os pedidos localmente. Mantém o servidor em execução durante a utilização.

As seguintes variáveis de ambiente são opcionais (também podem ser definidas no
`.env` da raiz em desenvolvimento):

```dotenv
AI_PROVIDER=lmstudio
LMSTUDIO_URL=http://127.0.0.1:1234
LMSTUDIO_MODEL=qwen2.5-14b-instruct
```

O valor de `LMSTUDIO_MODEL` tem de corresponder exatamente ao identificador
apresentado no servidor; confirma-o em `http://127.0.0.1:1234/v1/models`.
Nas definições da aplicação são apresentados o fornecedor, modelo e disponibilidade.
A disponibilidade confirma que o modelo consta da lista do servidor; a primeira
geração pode ainda precisar de o carregar. Não é efetuada inferência na verificação.
Reinicia a aplicação depois de alterar estas variáveis. Na aplicação instalada,
define-as no ambiente do processo/Windows antes de iniciar a aplicação.

Para voltar ao Ollama, define `AI_PROVIDER=ollama` e inicia-o numa consola:

```powershell
ollama serve
```

Nesta opção continuam disponíveis `OLLAMA_URL` (por defeito
`http://127.0.0.1:11434`) e `OLLAMA_MODEL` (por defeito `gemma4:12b`).
Esta configuração usa apenas inferência local, sem API cloud, chave ou mensalidade.
O Whisper e os dados existentes não são alterados pela escolha do servidor de IA.

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
- O primeiro pedido de IA pode demorar enquanto o LM Studio ou Ollama carrega o modelo.
- A aplicação só consegue captar áudio que o Windows e a aplicação de origem permitam disponibilizar por loopback.

## Projetos, etiquetas e trabalho diário

A vista Projetos permite criar e editar projetos e etiquetas e reúne reuniões, decisões,
notas e tarefas. Reuniões e notas têm controlos para atribuir projetos; tarefas escolhem
uma reunião e herdam exclusivamente o projeto dessa reunião. Etiquetas organizam as tarefas.
Acede a Projetos no menu lateral. A criação seleciona imediatamente o projeto e mostra
uma confirmação; a edição usa formulários da aplicação. Os seletores usam menus próprios
com navegação por setas, Enter para escolher e Escape para fechar.
Novas tarefas extraídas ficam associadas à reunião. Se a reunião mudar de projeto, as suas
tarefas acompanham essa mudança. Nas notas, um projeto próprio continua a prevalecer sobre
o projeto da reunião de origem.

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

## Integração GitLab — consulta e envio manual

A ligação está limitada a `https://gitlab.warpcom.com` e ao projeto
`serviceunit/django-apps/twinportal`. É necessário acesso VPN e um token pessoal com
scope `api` da conta `diogo.leonardo@warpcom.com`, com acesso ao projeto.
Introduz o token em Definições > GitLab na aplicação desktop. O Electron guarda-o
encriptado pelo Windows (`safeStorage`) na pasta de dados da aplicação. O backend
recebe-o apenas em memória; não é devolvido pela API nem guardado na SQLite.
O modo de desenvolvimento só em browser não persiste credenciais.

A sincronização e o modo de escrita estão **desativados por defeito**. Ativar a sincronização permite consultas
e importação. Desativar impede novos pedidos, incluindo novas páginas de uma
consulta em curso; um pedido HTTP já enviado pode terminar. O controlo está em Definições
e na aba Tarefas. Há sincronização ao iniciar o backend, a cada 60 segundos e no botão
Sincronizar agora, enquanto a aplicação estiver em execução, mesmo minimizada.

A identidade é confirmada pelo email de `/user` e a seleção usa o ID do responsável.
Só são importadas tarefas abertas atribuídas a essa conta; mencionar o nome ou ser autor
não basta. Tarefas já importadas são reconciliadas também quando fechadas ou reabertas.
Tarefas que deixem de estar atribuídas a ti são retiradas das vistas ativas e suspendem
alterações. Os registos locais são preservados. `Ocultar nesta app` conserva a identidade
externa e evita reimportação; não elimina nem fecha tarefas no GitLab.

Para consultar as tarefas ocultas, abre **Definições → GitLab → Ocultas**.
O botão **Voltar a mostrar** repõe a visibilidade local e atualiza a lista e os
contadores, sem enviar alterações ao GitLab. Se a tarefa estiver sem atribuição ou
acesso, só regressa às listas normais quando essa situação for resolvida.

As tarefas importadas mostram o ícone GitLab, que abre a origem no browser. As locais
continuam locais. As tarefas podem ser associadas a reuniões locais e herdam o projeto
dessas reuniões; esta organização é independente do projeto GitLab.
Etiquetas remotas mantêm referências por projeto/ID e só podem ser escolhidas no projeto
de origem. Renomear etiquetas importadas é feito no GitLab; retirar uma etiqueta de uma
tarefa é permitido localmente e fica pendente.

Concluir/reabrir, editar título/descrição e alterar etiquetas atualiza a app e guarda
alterações pendentes. Em Definições > GitLab, ativa **Permitir escrita no GitLab** e
clica em **Enviar alterações pendentes** para enviar os updates. A preferência é guardada
nas configurações existentes. A consulta automática e **Sincronizar agora** nunca enviam
alterações, mesmo com escrita ativa. O cliente verifica a autorização manual, o modo de
escrita e a sincronização antes de cada pedido de escrita. Um pedido já enviado pode terminar.
Antes do envio, a app volta a verificar a atribuição e os conflitos. Tarefas ocultas,
sem atribuição/acesso ou com conflitos não são enviadas. Falhas mantêm as alterações
pendentes e o card apresenta o resultado. O envio de alterações atualiza tarefas já
ligadas ao GitLab; reuniões, os respetivos projetos e lembretes continuam locais.

Nas tarefas locais, o botão **local → GitLab**, no lugar do ícone de origem, cria um
ticket no projeto GitLab configurado. Requer tarefa aberta com responsável **Eu**,
sincronização e escrita ativas e token configurado. Todas as labels têm de existir no
catálogo GitLab e é obrigatória pelo menos uma de **To Do**, **On Going** ou
**On Testing / Pending Deploy**. Labels inexistentes ou com vírgulas bloqueiam o envio;
o backend consulta novamente o catálogo antes da criação e não cria labels locais no GitLab.
Depois do sucesso, a mesma tarefa recebe a ligação e o ícone GitLab normal, mantendo
a origem local e a reunião. O Quadro continua a apresentar apenas o título.
Um registo de envio pendente nas configurações existentes impede outra criação após
uma resposta incerta ou uma falha ao guardar a ligação. Nesses casos, é necessário
verificar o ticket no GitLab antes de resolver o envio; não há repetição automática.

Ao concluir uma tarefa na app, são removidas apenas as suas associações às etiquetas
`To Do`, `On Going` e `On Testing / Pending Deploy`, quando existirem. As outras etiquetas
e o catálogo são preservados. Nas tarefas GitLab, a remoção fica pendente juntamente
com o fecho e é enviada pelo botão manual; a reconciliação também retira essas etiquetas
se forem adicionadas remotamente antes do envio do fecho pendente. Reabrir não as repõe.
Esta regra não altera retroativamente tarefas já fechadas.

### Tempo gasto por tarefa

Na vista Lista, **Registar tempo** adiciona horas e minutos ao total da tarefa.
Cada registo é guardado separadamente; guardar não altera o tempo anterior nem envia
pedidos de escrita ao GitLab. O tempo é preservado ao fechar ou reabrir a tarefa.
O Quadro continua a apresentar apenas o título.

Nas tarefas ligadas ao GitLab, a consulta importa o total remoto e o botão manual de
envio acrescenta apenas os registos locais pendentes, com escrita e sincronização ativas.
O total apresentado inclui o total GitLab confirmado e o tempo local pendente.
Tempo com resposta incerta aparece separadamente, porque pode já constar do total remoto;
esses registos não são repetidos automaticamente. Pedidos rejeitados continuam pendentes.
Ao publicar uma tarefa local, os registos mantêm-se na mesma tarefa e ficam pendentes
para o botão de envio. As alterações de título, labels e estado são confirmadas separadamente
dos registos de tempo, preservando sucessos parciais.

Os registos são persistidos na nova tabela `TaskTimeEntry`. A migration correspondente
tem de ser criada, revista e aplicada com as autorizações separadas previstas no projeto.

Na aba Tarefas, **Upload changes to GitLab** fica junto de **Desativar sincronização**
e envia todas as alterações GitLab pendentes, com os mesmos bloqueios do card nas
definições. Este envio é independente da seleção de tarefas.

O sincronismo compara a última versão remota com as alterações locais. Campos independentes
e alterações de etiquetas são conciliados; conflitos de título, descrição ou estado ficam
visíveis até escolher Manter alterações locais ou Usar versão GitLab. Sem rede, as alterações
continuam pendentes. Definições mostra última sincronização, pendentes, conflitos e erros.
Datas e horas de lembretes permanecem locais; a data limite remota é usada inicialmente
quando não existe data local. Não são sincronizados comentários, participantes ou reuniões.

A **data de início (`start_date`) é exclusivamente local**: não é consultada nem enviada
ao GitLab. Ao passar uma tarefa para `On Going`, a app continua a guardar a data local.
Datas de início anteriormente pendentes são preservadas na app e deixam de contar como
alterações por enviar durante a sincronização normal. A data local não acompanha futuras
alterações desse campo no GitLab. Títulos, descrições, etiquetas, estado, prazo, milestones,
estimativas e tempo gasto mantêm a sincronização existente. Esta mudança não exige migrations.

A migration `0011_label_views_gitlab` converte prioridades e separadores antes de remover
os campos antigos, acrescenta as tabelas da integração e mantém projetos/reuniões/notas.
Foi aplicada à base local com uma cópia SQLite consistente em `data/backups/`.
Também foi atualizada a base vazia `backend/template/notetaker.sqlite3` usada pelo
instalador, sem copiar tarefas, reuniões, projetos, credenciais ou dados pessoais.
Os testes de sincronismo simulam o GitLab e não fazem pedidos à instância real.

## Notas e organização

A aba **Notas** reúne as notas existentes de reuniões e as notas pessoais sem reunião.
Permite criar e editar título/conteúdo, associar reunião e projeto, pesquisar,
filtrar por origem/projeto e abrir a reunião de origem. Não duplica as notas.
As notas não usam etiquetas na interface; associações antigas ficam preservadas na base.
Arrasta a pega ⠿ de uma nota para a posição pretendida, ou usa as setas para cima/baixo
com a pega focada. A ordem fica guardada nesta instalação, incluindo após reiniciar,
e mantém-se nas atualizações. Com filtros, só são reorganizadas as posições das notas
visíveis. Novas notas aparecem depois das que já têm posição guardada.
O fluxo de organização das tarefas é **Projeto → Reuniões → Tarefas**. Uma tarefa só
pode ser associada a uma reunião, que determina o seu projeto. Os cartões e contagens
na aba **Projetos**, os filtros e a pesquisa seguem essa relação. Nas reuniões do projeto,
as tarefas reutilizam os mesmos cartões e controlos da aba Tarefas.
Tarefas existentes ou importadas sem reunião permanecem na aba **Tarefas**, onde podem
ser associadas a uma reunião. O campo antigo de projeto direto permanece na base por
compatibilidade, sem efeito funcional; não são feitas associações automáticas.

No modo **Quadro**, cada cartão apresenta apenas o título da tarefa e pode ser arrastado
pelo próprio cartão entre as colunas. A caixa de seleção aparece apenas com **Selecionar
tarefas** ativo. Os detalhes e as ações individuais continuam disponíveis no modo **Lista**.

Nas listas de Tarefas, Projetos e Reuniões, **Selecionar tarefas**, à direita de **Ordenar
por**, abre um popup e ativa caixas de seleção separadas do controlo de concluir/reabrir.
O popup reúne as ações em grupo; fechar com um clique fora ou Escape preserva a seleção.
**Terminar seleção** limpa-a e desativa as caixas. **Selecionar todas as filtradas** inclui as
tarefas das vistas recolhidas e conta cada tarefa uma vez, mesmo quando surge em várias
vistas por etiqueta. Tarefas que deixam de corresponder aos filtros saem da seleção.
**Adicionar labels** mantém as etiquetas existentes e só apresenta etiquetas compatíveis
com todas as tarefas selecionadas. **Fechar selecionadas** pede confirmação e aplica as
mesmas regras de fecho individual, ignorando as já concluídas. A operação é atómica:
se uma tarefa não permitir a ação, nenhuma é alterada. Os updates GitLab ficam pendentes.

Arrasta os cabeçalhos dos separadores por etiqueta para reorganizar a ordem, guardada
localmente e partilhada entre Lista e Quadro. Novas vistas surgem depois das existentes;
Sem etiqueta de vista e Concluídas mantêm as suas posições. Arrastar um separador não
altera etiquetas das tarefas. Para associar uma tarefa a um projeto, escolhe uma reunião
desse projeto no menu **Organizar → Reunião e etiquetas** da tarefa.

Em **Projetos > Gerir etiquetas**, **Eliminar** pede confirmação antes de remover uma
etiqueta local, as suas associações e a vista de tarefas correspondente. As tarefas,
reuniões e notas são preservadas. Etiquetas importadas permanecem geridas no GitLab.

## Início automático de reuniões Teams/Webex

A deteção automática está ativa por defeito e pode ser desligada em **Definições →
Iniciar reunião ao entrar no Teams ou Webex**. A preferência é aplicada imediatamente
e fica guardada nesta instalação. Requer o Nexus em execução, podendo estar
minimizado ou na bandeja. Não deteta reuniões no navegador.

Um processo PowerShell oculto usa o UI Automation do Windows para procurar os controlos
de terminar/sair e de áudio nas aplicações instaladas do Teams/Webex. Não clica
nesses controlos. São necessárias duas observações consecutivas, a intervalos de
quatro segundos, antes do início. A deteção pode variar com a versão, idioma
(controlos PT/EN) e disponibilidade da interface de acessibilidade dos clientes.
Abrir a aplicação ou ficar no ecrã de pré-entrada não deve iniciar uma reunião.

Ao detetar uma chamada, reutiliza a captura de microfone e áudio do sistema,
pausa a escuta ativa e apresenta uma notificação. Só pode existir uma captura
de reunião de cada vez. **Terminar reunião** continua a ser manual; sair do Teams
ou Webex não termina a captura. Uma paragem manual ou falha de início não volta
a tentar automaticamente na mesma chamada. Após três observações sem chamada,
a deteção fica pronta para uma nova entrada. Para voltar a gravar a chamada atual,
usa **Iniciar reunião**. Falhas de deteção ou permissões são apresentadas na aplicação.

Se existir uma gravação ativa e uma chamada tiver sido detetada durante essa gravação,
o fim da chamada gera um aviso na aplicação e uma notificação do Windows:
**A chamada terminou. A gravação continua ativa — termina-a quando quiseres.**
O aviso só aparece após três verificações consecutivas sem chamadas detetadas e
uma única vez por gravação, mesmo que a chamada reapareça. Se Teams e Webex estiverem
em chamada simultaneamente, aguarda que ambas terminem. Clicar na notificação abre
o Nexus; a gravação continua até carregares em **Terminar reunião**.
Falhas do detetor, desativar a deteção ou parar manualmente a gravação não geram
este aviso. Ao reativar a deteção, é necessário observar uma chamada novamente.

A ordenação das notas e a deteção não exigem dependências novas nem migrations.
