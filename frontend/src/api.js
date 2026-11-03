let configuration;


export async function getConfiguration() {
  if (!configuration) {
    configuration = window.notetaker
      ? await window.notetaker.config()
      : { apiBase: "http://127.0.0.1:8765/api", apiToken: "development-token" };
  }
  return configuration;
}

export async function api(path, options = {}) {
  const config = await getConfiguration();
  const headers = new Headers(options.headers || {});
  headers.set("X-Local-Token", config.apiToken);
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(`${config.apiBase}${path}`, { ...options, headers });
  if (!response.ok) {
    const detail = await response.text();
    let message = `API error ${response.status}`;
    try {
      const payload = JSON.parse(detail);
      // Field validation errors belong beside the form, not as raw JSON.
      message = payload.detail || Object.entries(payload).map(([field, errors]) => `${field}: ${Array.isArray(errors) ? errors.join(" ") : String(errors)}`).join("; ") || message;
    } catch {
      message = detail.startsWith("<") ? `API error ${response.status}. Verifica o backend.` : detail || message;
    }
    throw new Error(message);
  }
  if (response.status === 204) return null;
  return response.json();
}

export async function apiText(path) {
  const config = await getConfiguration();
  const response = await fetch(`${config.apiBase}${path}`, {
    headers: { "X-Local-Token": config.apiToken },
  });
  if (!response.ok) throw new Error(await response.text());
  return response.text();
}

// Use authenticated fetch and a data URL compatible with the existing image CSP.
export async function apiImage(path, { signal } = {}) {
  const config = await getConfiguration();
  const response = await fetch(`${config.apiBase}${path}`, {
    signal, headers: { "X-Local-Token": config.apiToken },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.detail || `Não foi possível carregar a imagem (${response.status}).`);
  }
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
