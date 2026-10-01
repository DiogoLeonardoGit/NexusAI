import { spawnSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const targets = await fetch("http://127.0.0.1:9222/json").then((response) => response.json());
const page = targets.find((target) => target.type === "page");
if (!page) throw new Error("No Electron page target found.");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

const value = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("MediaRecorder smoke test timed out.")), 10000);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== 2) return;
    clearTimeout(timeout);
    resolve(message.result.result.value);
  });
  socket.send(JSON.stringify({
    id: 2,
    method: "Runtime.evaluate",
    params: {
      expression: `(async () => {
        const context = new AudioContext();
        const destination = context.createMediaStreamDestination();
        const oscillator = context.createOscillator();
        oscillator.connect(destination);
        oscillator.start();
        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
        const recorder = new MediaRecorder(destination.stream, { mimeType });
        const blob = await new Promise((resolve) => {
          recorder.addEventListener("dataavailable", (event) => resolve(event.data), { once: true });
          recorder.start();
          setTimeout(() => recorder.stop(), 1000);
        });
        oscillator.stop();
        await context.close();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 8192) {
          binary += String.fromCharCode(...bytes.slice(offset, offset + 8192));
        }
        return JSON.stringify({ size: bytes.length, header: Array.from(bytes.slice(0, 4)), mimeType: blob.type, base64: btoa(binary) });
      })()`,
      awaitPromise: true,
      returnByValue: true,
    },
  }));
});
socket.close();

const result = JSON.parse(value);
if (result.size < 100 || result.header.join(",") !== "26,69,223,163") {
  throw new Error(`MediaRecorder did not produce a self-contained WebM: ${value}`);
}
const audioPath = join(tmpdir(), `mynotetaker-webm-smoke-${process.pid}.webm`);
writeFileSync(audioPath, Buffer.from(result.base64, "base64"));
const python = join(process.cwd(), ".venv", "Scripts", "python.exe");
const decoded = spawnSync(python, [join("scripts", "smoke_transcription.py"), audioPath], {
  cwd: process.cwd(),
  encoding: "utf8",
});
unlinkSync(audioPath);
if (decoded.status !== 0) throw new Error(decoded.stderr || decoded.stdout);
delete result.base64;
console.log(JSON.stringify({ ...result, whisper: JSON.parse(decoded.stdout) }));
