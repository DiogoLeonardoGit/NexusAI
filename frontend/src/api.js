let configuration;


export async function getConfiguration() {
  if (!configuration) {
    configuration = window.notetaker
      ? await window.notetaker.config()
      : { apiBase: "http://127.0.0.1:8765/api", apiToken: "development-token" };
  }
  return configuration;
}

// Status stays available to callers so deleted content can be handled normally.
export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request(path, options = {}) {
  const config = await getConfiguration();
  const headers = new Headers(options.headers || {});
  headers.set("X-Local-Token", config.apiToken);
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  let response;
  try {
    response = await fetch(`${config.apiBase}${path}`, { ...options, headers });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new ApiError("Não foi possível ligar ao serviço local. Tenta novamente dentro de instantes.");
  }
  if (!response.ok) {
    const messages = {
      401: "A ligação ao serviço local precisa de ser renovada. Reinicia a aplicação.",
      403: "Não tens permissão para realizar esta ação.",
      404: "Este conteúdo já não está disponível.",
    };
    let message = messages[response.status] || "Não foi possível concluir o pedido. Tenta novamente.";
    if (response.status < 500 && !messages[response.status]) {
      const payload = await response.json().catch(() => null);
      if (typeof payload?.detail === "string") message = payload.detail;
      else if (payload && typeof payload === "object") {
        const errors = Object.values(payload).flat().filter((value) => typeof value === "string");
        if (errors.length) message = errors.join(" ");
      }
    }
    throw new ApiError(message, response.status);
  }
  return response;
}

export async function api(path, options = {}) {
  const response = await request(path, options);
  if (response.status === 204) return null;
  return response.json();
}

export async function apiText(path) {
  const response = await request(path);
  return response.text();
}

// Authenticated blobs keep the local token out of player URLs.
export async function apiAudio(path, { signal } = {}) {
  const response = await request(path, { signal });
  return URL.createObjectURL(await response.blob());
}

// Use authenticated fetch and a data URL compatible with the existing image CSP.
export async function apiImage(path, { signal } = {}) {
  const response = await request(path, { signal });
  const blob = await response.blob();
  if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(blob.type) || blob.size > 15 * 1024 * 1024) {
    throw new Error("Formato ou tamanho de imagem não suportado.");
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Não foi possível ler a imagem."));
    reader.readAsDataURL(blob);
  });
}
