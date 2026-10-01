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
