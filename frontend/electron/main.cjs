const { app, BrowserWindow, Menu, Notification, Tray, desktopCapturer, dialog, ipcMain, nativeImage, session, powerSaveBlocker, safeStorage, shell } = require("electron");
const { randomBytes } = require("crypto");
const { spawn } = require("child_process");
const path = require("path");

const isDev = !app.isPackaged;
const apiToken = randomBytes(32).toString("hex");
const apiBase = "http://127.0.0.1:8765/api";
let mainWindow;
let tray;
let captureState = "paused";
const backendProcesses = [];
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const appDisplayName = "My AI Notetaker";
const existingUserDataPath = path.join(app.getPath("appData"), "My Notetaker");
let powerSaveBlockerId = null;
const activeNotifications = new Set();

function updatePowerSaveBlocker(enabled) {
  const shouldBlock = Boolean(enabled);
  if (shouldBlock && powerSaveBlockerId === null) {
    powerSaveBlockerId = powerSaveBlocker.start("prevent-display-sleep");
  } else if (!shouldBlock && powerSaveBlockerId !== null) {
    powerSaveBlocker.stop(powerSaveBlockerId);
    powerSaveBlockerId = null;
  }
}

app.setPath("userData", existingUserDataPath);
app.setName(appDisplayName);

if (!hasSingleInstanceLock) app.quit();

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function appIcon(extension = "ico") {
  return path.join(__dirname, "..", "build", `icon.${extension}`);
}

function backendCommand(worker = false) {
  if (app.isPackaged) {
    return {
      executable: path.join(process.resourcesPath, "backend", "notetaker-backend.exe"),
      args: worker ? ["--worker"] : [],
    };
  }
  const projectRoot = path.resolve(__dirname, "..", "..");
  return {
    executable: process.env.NOTETAKER_PYTHON || path.join(projectRoot, ".venv", "Scripts", "python.exe"),
    args: worker ? ["manage.py", "process_jobs"] : ["-m", "config.server"],
    cwd: path.join(projectRoot, "backend"),
  };
}

function startBackend() {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const dataDir = isDev ? path.join(projectRoot, "data") : app.getPath("userData");
  if (!isDev) {
    const fs = require("fs");
    const database = path.join(dataDir, "notetaker.sqlite3");
    if (!fs.existsSync(database)) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.copyFileSync(path.join(process.resourcesPath, "backend-template", "notetaker.sqlite3"), database);
    }
  }
  const env = {
    ...process.env,
    NOTETAKER_API_TOKEN: apiToken,
    NOTETAKER_DATA_DIR: dataDir,
    NOTETAKER_GITLAB_TOKEN: readGitLabToken(),
    WHISPER_MODEL: isDev
      ? path.join(projectRoot, "models", "faster-whisper-medium")
      : path.join(process.resourcesPath, "models", "faster-whisper-medium"),
    DIARIZATION_SEGMENTATION_MODEL: isDev
      ? path.join(projectRoot, "models", "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx")
      : path.join(process.resourcesPath, "models", "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx"),
    DIARIZATION_EMBEDDING_MODEL: isDev
      ? path.join(projectRoot, "models", "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx")
      : path.join(process.resourcesPath, "models", "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"),
  };
  for (const command of [backendCommand(), backendCommand(true)]) {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env,
      windowsHide: true,
    });

    backendProcesses.push(child);

    child.stdout.on("data", (data) => {
      console.log(`[backend stdout] ${data.toString()}`);
    });

    child.stderr.on("data", (data) => {
      console.error(`[backend stderr] ${data.toString()}`);
    });

    child.on("exit", (code, signal) => {
      console.error(`[backend exit] code=${code} signal=${signal}`);
    });

    child.on("error", (error) => {
      console.error("[backend process error]", error);
    });
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0d1117",
    icon: appIcon(),
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
    console.error(`Failed to load ${url}: ${code} ${description}`);
  });
  if (isDev) mainWindow.loadURL("http://127.0.0.1:5173");
  else mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  mainWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(appIcon("png")).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  const rebuild = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Abrir My Notetaker", click: () => mainWindow.show() },
    { label: captureState === "meeting" ? "Em reunião" : captureState === "active-listening" ? "Escuta ativa" : "Captura pausada", enabled: false },
    { type: "separator" },
    { label: "Sair", click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.rebuild = rebuild;
  rebuild();
  tray.on("double-click", () => mainWindow.show());
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  app.setAppUserModelId("local.mynotetaker.app");
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(["media", "notifications"].includes(permission));
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ["screen"] });
    callback({ video: sources[0], audio: "loopback" });
  });
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = /^(file:|blob:|devtools:|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/)/.test(details.url);
    callback({ cancel: !allowed });
  });
  startBackend();
  createWindow();
  createTray();
});

ipcMain.handle("config:get", () => ({ apiBase, apiToken }));

// The token is encrypted by Windows and is never returned to the renderer.
function readGitLabToken() {
  const fs = require("fs");
  const tokenPath = path.join(app.getPath("userData"), "gitlab-token.enc");
  if (!fs.existsSync(tokenPath)) return "";
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Encryption unavailable");
    return safeStorage.decryptString(fs.readFileSync(tokenPath));
  } catch {
    console.error("Não foi possível desbloquear o token GitLab. Introduz novamente o token nas definições.");
    return "";
  }
}

ipcMain.handle("gitlab:token", async (event, value) => {
  if (event.sender !== mainWindow?.webContents || typeof value !== "string" || value.length > 4096 || /[\r\n]/.test(value)) {
    throw new Error("Pedido de credencial inválido.");
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Proteção de credenciais Windows indisponível.");
  const fs = require("fs");
  const tokenPath = path.join(app.getPath("userData"), "gitlab-token.enc");
  const token = value.trim();
  const response = await fetch(apiBase + "/gitlab/credentials/", {
    method: "POST", headers: { "X-Local-Token": apiToken, "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw new Error("Não foi possível guardar a credencial no backend local.");
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  if (token) fs.writeFileSync(tokenPath, safeStorage.encryptString(token));
  else if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
  return { has_token: Boolean(token) };
});

ipcMain.handle("gitlab:open", async (event, value) => {
  if (event.sender !== mainWindow?.webContents) throw new Error("Pedido inválido.");
  const url = new URL(value);
  if (url.origin !== "https://gitlab.warpcom.com" || url.username || url.password) throw new Error("Ligação GitLab inválida.");
  await shell.openExternal(url.href);
});
ipcMain.handle("notification:show", (_event, payload) => {
  if (!Notification.isSupported()) return false;
  const notification = new Notification({ title: payload.title, body: payload.body });
  // Retain each notification until Windows dismisses it or delivers its click.
  activeNotifications.add(notification);
  const release = () => activeNotifications.delete(notification);
  notification.on("close", release);
  notification.on("failed", release);
  notification.on("click", () => {
    release();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send("notification:open", payload.target || {});
  });
  notification.show();
  return true;
});
ipcMain.handle("export:pdf", async (_event, { defaultPath }) => {
  const suggestedPath = defaultPath
    ? (path.isAbsolute(defaultPath) ? defaultPath : path.join(app.getPath("documents"), defaultPath))
    : path.join(app.getPath("documents"), `notetaker-${Date.now()}.pdf`);
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: suggestedPath,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (result.canceled || !result.filePath) return null;
  const data = await mainWindow.webContents.printToPDF({ printBackground: true });
  require("fs").writeFileSync(result.filePath, data);
  return result.filePath;
});
ipcMain.handle("export:text", async (_event, { content, defaultPath }) => {
  const isHtml = path.extname(defaultPath || "").toLowerCase() === ".html";
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultPath || path.join(app.getPath("documents"), `notetaker-${Date.now()}.md`),
    filters: [isHtml
      ? { name: "HTML", extensions: ["html"] }
      : { name: "Markdown", extensions: ["md"] }],
  });
  if (result.canceled || !result.filePath) return null;
  require("fs").writeFileSync(result.filePath, content, "utf8");
  return result.filePath;
});
ipcMain.on("capture:state", (_event, state) => {
  captureState = ["active-listening", "meeting"].includes(state) ? state : "paused";
  tray?.rebuild();
});

ipcMain.on("display-awake:set", (_event, enabled) => {
  updatePowerSaveBlocker(enabled);
});
ipcMain.handle("login:get", () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle("login:set", (_event, enabled) => {
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
  return app.getLoginItemSettings().openAtLogin;
});

app.on("before-quit", () => {
  app.isQuitting = true;
  backendProcesses.forEach((process) => process.kill());
});
app.on("window-all-closed", () => {});
