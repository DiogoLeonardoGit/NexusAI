# My AI Notetaker

Assistente pessoal desktop para Windows. Captura microfone e áudio do sistema, transcreve português e inglês com Faster Whisper e usa o `gemma4:12b` local através do Ollama para criar resumos, tarefas e lembretes.

Todo o áudio e texto permanece no computador. O frontend bloqueia pedidos para destinos que não sejam `localhost` e o backend escuta apenas em `127.0.0.1`.

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
