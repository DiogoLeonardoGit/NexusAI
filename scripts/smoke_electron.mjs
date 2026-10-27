const targets = await fetch("http://127.0.0.1:9222/json").then((response) => response.json());
const page = targets.find((target) => target.type === "page");
if (!page) throw new Error("No Electron page target found.");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("CDP evaluation timed out.")), 5000);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    clearTimeout(timeout);
    resolve(message.result.result.value);
  });
  socket.send(JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: {
      expression: `(async () => {
        const config = await window.notetaker.config();
        const response = await fetch(config.apiBase + "/tasks/", { headers: { "X-Local-Token": config.apiToken } });
        const devices = await navigator.mediaDevices.enumerateDevices();
        return JSON.stringify({
          title: document.title,
          rootChildren: document.querySelector("#root")?.children.length ?? 0,
          text: document.body.innerText.slice(0, 500),
          apiStatus: response.status,
          hasMediaDevices: Boolean(navigator.mediaDevices),
          audioInputs: devices.filter((device) => device.kind === "audioinput").length,
        });
      })()`,
      awaitPromise: true,
      returnByValue: true,
    },
  }));
});
socket.close();

const state = JSON.parse(result);
if (state.title !== "Nexus" || state.rootChildren < 1 || !state.text.includes("Iniciar reunião") || state.apiStatus !== 200 || !state.hasMediaDevices) {
  throw new Error(`Unexpected UI state: ${result}`);
}
console.log(result);
