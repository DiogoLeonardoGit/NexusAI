const { app, BrowserWindow, Menu, Notification, Tray, desktopCapturer, dialog, ipcMain, nativeImage, session, powerSaveBlocker, safeStorage, shell } = require("electron");
const { randomBytes, createHash } = require("crypto");
const { spawn } = require("child_process");
const path = require("path");
const { MeetingDetector } = require("./meeting-detector.cjs");

const isDev = !app.isPackaged;
// Keep development shortcuts and taskbar grouping separate from the installed app.
const appUserModelId = isDev ? "local.nexusai.app.dev" : "local.nexusai.app";
const apiToken = randomBytes(32).toString("hex");
const apiBase = "http://127.0.0.1:8765/api";
let mainWindow;
let tray;
let captureState = "paused";
let trayControls = { ready: false, recording: false, listeningEnabled: false, busy: false };
let trayCapturePermitUntil = 0;
const backendProcesses = [];
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const appDisplayName = "Nexus";
// Retain the original data location so existing notes, settings and encrypted credentials stay available.
const existingUserDataPath = path.join(app.getPath("appData"), "My Notetaker");
let powerSaveBlockerId = null;
const activeNotifications = new Set();
const meetingDetector = new MeetingDetector((state) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("meeting:detection", state);
});

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
  // Windows shell icons need a real filesystem path outside the ASAR archive.
  if (app.isPackaged) return path.join(process.resourcesPath, "icons", `icon.${extension}`);
  return path.join(__dirname, "..", "build", `icon.${extension}`);
}

// Temporary bounded diagnostics contain only icon metadata, never process env.
function recordIconDiagnostic(details) {
  const fs = require("fs");
  try {
    const folder = path.join(app.getPath("userData"), "diagnostics");
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, "window-icons.jsonl");
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) {
      fs.rmSync(file + ".1", { force: true });
      fs.renameSync(file, file + ".1");
    }
    fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...details }) + "\n");
  } catch {
    console.error("Could not write window icon diagnostics.");
  }
}

// Compare resources decoded by Electron with the icon exposed by Windows.
async function diagnoseWindowIcons() {
  const fs = require("fs");
  const resources = {};
  for (const extension of ["ico", "png"]) {
    const file = appIcon(extension);
    const image = nativeImage.createFromPath(file);
    resources[extension] = {
      exists: fs.existsSync(file), empty: image.isEmpty(), size: image.getSize(),
      fileHash: fs.existsSync(file) ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null,
    };
  }
  recordIconDiagnostic({ event: "window-created", packaged: app.isPackaged,
    electron: process.versions.electron, resources, configuredAppId: appUserModelId });
  try {
    const image = await app.getFileIcon(process.execPath, { size: "normal" });
    recordIconDiagnostic({ event: "windows-executable-icon", empty: image.isEmpty(),
      size: image.getSize(), imageHash: createHash("sha256").update(image.toPNG()).digest("hex") });
  } catch {
    recordIconDiagnostic({ event: "windows-executable-icon", failed: true });
  }
  diagnoseNativeWindowIcon();
}

// Read the live HWND icons without changing window state or Windows caches.
function diagnoseNativeWindowIcon() {
  const handle = mainWindow.getNativeWindowHandle();
  const windowId = handle.length === 8 ? handle.readBigUInt64LE().toString() : handle.readUInt32LE().toString();
  const script = `
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WindowIconProbe {
 [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr wp, IntPtr lp, uint flags, uint timeout, out IntPtr result);
 [DllImport("user32.dll", EntryPoint="GetClassLongPtrW")] public static extern IntPtr GetClassLongPtr(IntPtr h, int index);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern uint PrivateExtractIcons(string file,int index,int x,int y,IntPtr[] icons,uint[] ids,uint count,uint flags);
 [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr icon);
}
'@
function Get-IconDigest($icon) {
 $bitmap = $icon.ToBitmap()
 $stream = New-Object System.IO.MemoryStream
 $hasher = [Security.Cryptography.SHA256]::Create()
 try {
  $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
  return @{ width=$bitmap.Width; height=$bitmap.Height; hash=[BitConverter]::ToString($hasher.ComputeHash($stream.ToArray())) }
 } finally { $hasher.Dispose(); $stream.Dispose(); $bitmap.Dispose() }
}
$window = [IntPtr]([long]$env:NOTETAKER_DIAG_WINDOW)
$results = @{}
foreach ($kind in @(0,1,2)) {
 $iconHandle = [IntPtr]::Zero
 [void][WindowIconProbe]::SendMessageTimeout($window,127,[IntPtr]$kind,[IntPtr]::Zero,2,1000,[ref]$iconHandle)
 $results["window_"+$kind] = if ($iconHandle -ne [IntPtr]::Zero) { Get-IconDigest ([Drawing.Icon]::FromHandle($iconHandle)) } else { $null }
}
foreach ($index in @(-14,-34)) {
 $iconHandle = [WindowIconProbe]::GetClassLongPtr($window,$index)
 $results["class_"+$index] = if ($iconHandle -ne [IntPtr]::Zero) { Get-IconDigest ([Drawing.Icon]::FromHandle($iconHandle)) } else { $null }
}
foreach ($size in @(16,32,48)) {
 $icons = New-Object IntPtr[] 1
 $ids = New-Object uint32[] 1
 [void][WindowIconProbe]::PrivateExtractIcons($env:NOTETAKER_DIAG_ICON,0,$size,$size,$icons,$ids,1,0)
 if ($icons[0] -ne [IntPtr]::Zero) {
  try { $results["expected_"+$size] = Get-IconDigest ([Drawing.Icon]::FromHandle($icons[0])) }
  finally { [void][WindowIconProbe]::DestroyIcon($icons[0]) }
 }
}
$results | ConvertTo-Json -Depth 4 -Compress
`;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], {
    windowsHide: true,
    env: { ...process.env, NOTETAKER_DIAG_WINDOW: windowId, NOTETAKER_DIAG_ICON: appIcon() },
  });
  let output = "";
  const timeout = setTimeout(() => child.kill(), 15000);
  child.stdout.on("data", (data) => { if (output.length < 16384) output += data.toString(); });
  // Never persist PowerShell's raw errors, which can include local paths.
  child.stderr.resume();
  child.on("error", () => { clearTimeout(timeout); recordIconDiagnostic({ event: "native-window-icons", failed: true }); });
  child.on("close", (code) => {
    clearTimeout(timeout);
    try {
      if (code !== 0) throw new Error("Probe failed");
      recordIconDiagnostic({ event: "native-window-icons", icons: JSON.parse(output) });
    } catch {
      recordIconDiagnostic({ event: "native-window-icons", failed: true, exitCode: code });
    }
  });
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
    NOTETAKER_DIAGNOSTICS: "1",
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
  if (process.platform === "win32") {
    mainWindow.setAppDetails({
      appId: appUserModelId,
      appIconPath: appIcon(),
      appIconIndex: 0,
      relaunchDisplayName: appDisplayName,
    });
    diagnoseWindowIcons().catch(() => recordIconDiagnostic({ event: "window-diagnostics", failed: true }));
  }
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

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Native clicks dispatch fixed commands; the renderer owns the capture lifecycle.
function sendTrayCommand(action) {
  if (!mainWindow || mainWindow.isDestroyed() || !trayControls.ready || trayControls.busy) return;
  if (action === "start-meeting") {
    if (trayControls.recording) return;
    // One native activation is allowed after pending microphone uploads finish.
    trayCapturePermitUntil = Date.now() + 120000;
    showMainWindow();
  } else if (action === "stop-meeting") {
    if (!trayControls.recording) return;
  } else if (action === "toggle-listening") {
    if (trayControls.recording) return;
    if (!trayControls.listeningEnabled) showMainWindow();
  } else return;
  trayControls = { ...trayControls, busy: true };
  tray?.rebuild();
  mainWindow.webContents.send("tray:command", action);
}

function createTray() {
  // Prefer the PNG for resizing, with the Windows icon as a checked fallback.
  let image = nativeImage.createFromPath(appIcon("png"));
  if (image.isEmpty()) image = nativeImage.createFromPath(appIcon());
  if (image.isEmpty()) throw new Error("Não foi possível carregar o ícone da bandeja.");
  const icon = image.resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip(appDisplayName);
  const rebuild = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Abrir Nexus", click: showMainWindow },
    { label: "Iniciar reunião", enabled: trayControls.ready && !trayControls.busy && !trayControls.recording, click: () => sendTrayCommand("start-meeting") },
    ...(trayControls.recording ? [{ label: "Terminar gravação", enabled: !trayControls.busy, click: () => sendTrayCommand("stop-meeting") }] : []),
    { label: trayControls.listeningEnabled ? "Desativar escuta ativa" : "Ativar escuta ativa", enabled: trayControls.ready && !trayControls.busy && !trayControls.recording, click: () => sendTrayCommand("toggle-listening") },
    { type: "separator" },
    { label: "Sair", click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.rebuild = rebuild;
  rebuild();
  tray.on("double-click", showMainWindow);
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  app.setAppUserModelId(appUserModelId);
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
ipcMain.handle("meeting:detection:set", (event, enabled) => {
  if (event.sender !== mainWindow?.webContents || typeof enabled !== "boolean") throw new Error("Pedido inválido.");
  return meetingDetector.setEnabled(enabled);
});
// Grant activation only after a detected call or an unconsumed native tray click.
// No renderer-supplied JavaScript crosses this bridge.
ipcMain.handle("meeting:capture:activate", async (event) => {
  const detectedCall = meetingDetector.enabled && meetingDetector.state.calls.length && !meetingDetector.state.error;
  const trayStart = Date.now() < trayCapturePermitUntil;
  if (event.sender !== mainWindow?.webContents || (!detectedCall && !trayStart)) {
    throw new Error("Não existe um início de reunião autorizado. Usa Iniciar reunião para tentar novamente.");
  }
  trayCapturePermitUntil = 0;
  await mainWindow.webContents.executeJavaScript("window.dispatchEvent(new Event('notetaker:request-display-media')); void 0;", true);
});

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
    : path.join(app.getPath("documents"), `nexus-${Date.now()}.pdf`);
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
    defaultPath: defaultPath || path.join(app.getPath("documents"), `nexus-${Date.now()}.md`),
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

// Accept control state only from this window, never from other renderer senders.
ipcMain.on("tray:state", (event, state) => {
  if (event.sender !== mainWindow?.webContents || !state ||
      ["recording", "listeningEnabled", "busy"].some((key) => typeof state[key] !== "boolean")) return;
  trayControls = { ready: true, recording: state.recording, listeningEnabled: state.listeningEnabled, busy: state.busy };
  if (!state.busy) trayCapturePermitUntil = 0;
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
  meetingDetector.setEnabled(false);
  backendProcesses.forEach((process) => process.kill());
});
app.on("window-all-closed", () => {});
