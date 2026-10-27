const { spawn } = require("child_process");
const { createInterface } = require("readline");
const path = require("path");
const { readFileSync } = require("fs");

// Keep UI Automation outside Electron: a stalled provider must not block the app.
class MeetingDetector {
  constructor(onState) {
    this.onState = onState;
    this.enabled = false;
    this.state = { calls: [], error: "" };
    this.samples = new Map();
  }

  publish(error = "") {
    this.state = { calls: [...this.samples.values()].filter((item) => item.active).map(({ id, name }) => ({ id, name })), error };
    this.onState(this.state);
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) {
      clearTimeout(this.retry);
      this.retry = null;
      clearInterval(this.watchdog);
      const child = this.child;
      this.child = null;
      child?.kill();
      this.samples.clear();
      this.publish();
    } else if (!this.child && !this.retry) this.start();
    return this.state;
  }

  start() {
    if (process.platform !== "win32") {
      this.publish("A deteção automática de reuniões requer Windows.");
      return;
    }
    const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    // Electron can read inside app.asar; PowerShell cannot open paths in it.
    // Pass the bundled script in memory, without copying executable files.
    const script = readFileSync(path.join(__dirname, "meeting-detector.ps1"), "utf8");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    let lastSample = Date.now();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (this.child !== child) return;
      try {
        const sample = JSON.parse(line);
        if (!Array.isArray(sample.calls)) throw new Error("Invalid detector response");
        lastSample = Date.now();
        // Unknown observations never rearm a manually stopped meeting.
        if (sample.error) { this.publish("Não foi possível consultar as chamadas Teams/Webex. A deteção voltará a tentar."); return; }
        const calls = sample.calls.filter((call) => ["teams", "webex"].includes(call.id));
        const present = new Set(calls.map((call) => call.id));
        for (const call of calls) {
          const item = this.samples.get(call.id) || { ...call, hits: 0, misses: 0, active: false };
          item.hits += 1; item.misses = 0;
          if (item.hits >= 2) item.active = true;
          this.samples.set(call.id, item);
        }
        for (const [id, item] of this.samples) {
          if (present.has(id)) continue;
          item.hits = 0; item.misses += 1;
          if (item.misses >= 3) this.samples.delete(id);
        }
        this.publish();
      } catch (error) {
        console.error("[meeting detector]", error.message);
        this.publish("Resposta inválida da deteção de reuniões.");
      }
    });
    child.stderr.on("data", () => {
      if (this.child === child) this.publish("Não foi possível executar a deteção de reuniões.");
    });
    const finish = () => {
      if (this.child !== child) return;
      this.child = null;
      lines.close();
      clearInterval(this.watchdog);
      if (!this.enabled) return;
      this.publish("Deteção de reuniões indisponível. A reiniciar…");
      this.retry = setTimeout(() => { this.retry = null; if (this.enabled) this.start(); }, 10_000);
    };
    child.on("error", finish);
    child.on("exit", finish);
    this.watchdog = setInterval(() => {
      if (Date.now() - lastSample > 20_000) child.kill();
    }, 5000);
  }
}

module.exports = { MeetingDetector };
