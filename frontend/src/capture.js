import { api } from "./api";


const CHUNK_INTERVAL_MS = 60_000;

function supportedMimeType() {
  return ["audio/webm;codecs=opus", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

export function recorderFor(stream, source, sessionId, onError, pendingUploads, uploadPath = null) {
  let recorder;
  let timer;
  let stopped = false;
  let chunkStartedAt;

  const startChunk = () => {
    if (stopped) return;
    chunkStartedAt = Date.now();
    recorder = new MediaRecorder(stream, {
      mimeType: supportedMimeType(),
      audioBitsPerSecond: 128_000,
    });
    recorder.addEventListener("dataavailable", async (event) => {
      if (!event.data.size) return;
      const form = new FormData();
      form.append("audio", event.data, `${source}-${Date.now()}.webm`);
      form.append("source", source);
      form.append("started_at", new Date(chunkStartedAt).toISOString());
      form.append("duration_ms", String(Math.max(0, Date.now() - chunkStartedAt)));
      const upload = api(uploadPath || `/sessions/${sessionId}/audio/`, { method: "POST", body: form })
        .catch((error) => onError(error));
      pendingUploads.push(upload);
      await upload;
      pendingUploads.splice(pendingUploads.indexOf(upload), 1);
    });
    recorder.addEventListener("stop", () => {
      clearTimeout(timer);
      if (!stopped) startChunk();
    }, { once: true });
    // Starting without a timeslice ensures every stop emits a self-contained WebM.
    recorder.start();
    timer = setTimeout(() => recorder.state !== "inactive" && recorder.stop(), CHUNK_INTERVAL_MS);
  };

  startChunk();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      if (!recorder || recorder.state === "inactive") return;
      await new Promise((resolve) => {
        recorder.addEventListener("stop", resolve, { once: true });
        recorder.stop();
      });
    },
  };
}

export async function startCapture(onError, microphoneDeviceId = "") {
  const session = await api("/sessions/", {
    method: "POST",
    body: JSON.stringify({ title: `Sessão ${new Date().toLocaleString()}`, started_at: new Date().toISOString() }),
  });
  let microphone;
  let display;
  try {
    microphone = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: microphoneDeviceId ? { exact: microphoneDeviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const systemTracks = display.getAudioTracks();
    if (!systemTracks.length) throw new Error("O Windows não disponibilizou áudio do sistema para esta captura.");
    const systemAudio = new MediaStream(systemTracks);
    display.getVideoTracks().forEach((track) => track.stop());
    const pendingUploads = [];
    const recorders = [
      recorderFor(microphone, "microphone", session.id, onError, pendingUploads),
      recorderFor(systemAudio, "system", session.id, onError, pendingUploads),
    ];
    return {
      session,
      async stop() {
        const endedAt = new Date().toISOString();
        try {
          await Promise.all(recorders.map((recorder) => recorder.stop()));
          await Promise.all(pendingUploads);
        } finally {
          microphone.getTracks().forEach((track) => track.stop());
          systemAudio.getTracks().forEach((track) => track.stop());
          await api(`/sessions/${session.id}/complete/`, {
            method: "POST",
            body: JSON.stringify({ ended_at: endedAt }),
          });
        }
      },
    };
  } catch (error) {
    microphone?.getTracks().forEach((track) => track.stop());
    display?.getTracks().forEach((track) => track.stop());
    await api(`/sessions/${session.id}/complete/`, { method: "POST" }).catch(onError);
    throw error;
  }
}

export async function startActiveListening(onError, microphoneDeviceId = "") {
  const microphone = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: microphoneDeviceId ? { exact: microphoneDeviceId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const pendingUploads = [];
  const recorder = recorderFor(
    microphone,
    "microphone",
    null,
    onError,
    pendingUploads,
    "/active-listening/",
  );
  return {
    async stop() {
      try {
        await recorder.stop();
        await Promise.all(pendingUploads);
      } finally {
        microphone.getTracks().forEach((track) => track.stop());
      }
    },
  };
}